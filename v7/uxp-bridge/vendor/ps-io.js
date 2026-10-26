// ============================================================
//  ps-io.js
//  PS 文档/选区 IO（选区检测、图像抓取、图层贴回、编组蒙版）
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createPSIOModule 注入外部依赖。
// ============================================================

function createPSIOModule(deps) {
    var app = deps.app;
    var core = deps.core;
    var constants = deps.constants || {};
    var imaging = deps.imaging;
    var fs = deps.fs;
    var storage = deps.storage;
    var logToPanel = deps.logToPanel;
    var sendToPanel = deps.sendToPanel;
    var base64ToArrayBuffer = deps.base64ToArrayBuffer;
    var arrayBufferToBase64 = deps.arrayBufferToBase64;
    var pixelsHueShift180 = deps.pixelsHueShift180;
    var pixelsFlipVertical = deps.pixelsFlipVertical;
    var encodeJPEGFromRGB = deps.encodeJPEGFromRGB;
    var encodePNGFromRGB = deps.encodePNGFromRGB;
    var injectSRGBChunkIntoPNG = deps.injectSRGBChunkIntoPNG;
    var shouldApplyReturnFeather = deps.shouldApplyReturnFeather;
    // state accessors
    var state = deps.state; // { get/set for g_antiTruncationMode, g_maxResolution, etc. }

// === 取消选区 ===
// ⭐ 2026-10-18 最低版本降到 PS 24.4（docs/239）：selection 对象 PS 25.0 才有，
//   老版本直接走 batchPlay（跟 _deselectInModal 同一条命令），别静默失败、抓完图选区还留着。
async function deselectAll() {
    try {
        await core.executeAsModal(async function() {
            var sel = app.activeDocument && app.activeDocument.selection;
            if (sel && typeof sel.deselect === "function") await sel.deselect();
            else await _deselectInModal();
        }, { commandName: "取消选区" });
    } catch (e) {}
}

// ============================================================
//  核心功能函数
// ============================================================

// 自动扩充+裁切(发送侧): 把非方形像素补纯白凑成正方形(短边两侧对称填充)
// 纯内存操作, 不动 PS 画布。comp=3(RGB)/4(RGBA), 白=255(alpha 也 255)
function padPixelsToSquare(pixels, pw, ph, comp) {
    var side = Math.max(pw, ph);
    var out = new Uint8Array(side * side * comp);
    out.fill(255);
    var offX = Math.floor((side - pw) / 2);
    var offY = Math.floor((side - ph) / 2);
    var rowBytes = pw * comp;
    for (var y = 0; y < ph; y++) {
        var srcStart = y * rowBytes;
        var dstStart = ((y + offY) * side + offX) * comp;
        out.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart);
    }
    return { pixels: out, side: side };
}

// opts.padToSquare: 生图比例 1:1 且选区非方形时, 补白凑方(自动扩充+裁切功能, 由调用方判定开关)
// 触发后 result.selection 变为"虚拟方形框"(文档坐标, 以原选区为中心外扩), 供贴回对齐;
// 原选区存进 selection.cropRect, 贴回时按它加蒙版裁掉白边。
async function getSelectionAndImage(predefinedSelection, opts) {
    var result = null;
    getSelectionAndImage.lastError = null;
    try {
        await core.executeAsModal(async function() {
            var doc = app.activeDocument;
            var selBounds;
            if (predefinedSelection) {
                selBounds = {
                    left: Math.round(predefinedSelection.left), top: Math.round(predefinedSelection.top),
                    right: Math.round(predefinedSelection.right), bottom: Math.round(predefinedSelection.bottom),
                    width: Math.round(predefinedSelection.width), height: Math.round(predefinedSelection.height)
                };
            } else {
                // === 多版本兼容选区检测（3种方法自动降级） ===
                var _selRetries = 2;
                var _selLastErr = null;
                var _selOk = false;
                var _selProbeCompleted = false;
                logToPanel("[选区] 开始检测选区...(文档: " + doc.name + ", " + doc.width + "x" + doc.height + ")", "info");

                while (_selRetries >= 0 && !_selOk) {
                    // 方法1: DOM API doc.selection.bounds
                    logToPanel("[选区] 尝试方法1: DOM API doc.selection.bounds...", "info");
                    try {
                        var b = doc.selection.bounds;
                        _selProbeCompleted = true;
                        if (b && typeof b.left === 'number' && typeof b.right === 'number'
                            && !isNaN(b.left) && !isNaN(b.right) && (b.right - b.left) > 0) {
                            selBounds = {
                                left: Math.round(b.left), top: Math.round(b.top),
                                right: Math.round(b.right), bottom: Math.round(b.bottom),
                                width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top)
                            };
                            _selOk = true;
                            logToPanel("[选区] 方法1成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                            break;
                        } else {
                            logToPanel("[选区] 方法1: bounds存在但无效 (left=" + (b && b.left) + " right=" + (b && b.right) + ")", "warn");
                        }
                    } catch (e1) { _selLastErr = e1; logToPanel("[选区] 方法1失败: " + (e1.message || e1), "warn"); }

                    // 方法2: batchPlay 读取选区（兼容更多PS版本）
                    if (!_selOk) {
                        logToPanel("[选区] 尝试方法2: batchPlay读取选区...", "info");
                        try {
                            var bpResult = await app.batchPlay([{
                                _obj: "get",
                                _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                            }], {});
                            _selProbeCompleted = true;
                            if (bpResult && bpResult[0] && bpResult[0].selection) {
                                var sel = bpResult[0].selection;
                                // 尝试读取选区边界（可能是 rectangle 或 path 格式）
                                var sLeft, sTop, sRight, sBottom;
                                if (sel.left !== undefined) {
                                    sLeft = sel.left._value !== undefined ? sel.left._value : sel.left;
                                    sTop = sel.top._value !== undefined ? sel.top._value : sel.top;
                                    sRight = sel.right._value !== undefined ? sel.right._value : sel.right;
                                    sBottom = sel.bottom._value !== undefined ? sel.bottom._value : sel.bottom;
                                } else if (sel._obj === 'rectangle') {
                                    sLeft = sel.left._value; sTop = sel.top._value;
                                    sRight = sel.right._value; sBottom = sel.bottom._value;
                                }
                                if (sLeft !== undefined && sRight !== undefined && (sRight - sLeft) > 0) {
                                    selBounds = {
                                        left: Math.round(sLeft), top: Math.round(sTop),
                                        right: Math.round(sRight), bottom: Math.round(sBottom),
                                        width: Math.round(sRight - sLeft), height: Math.round(sBottom - sTop)
                                    };
                                    _selOk = true;
                                    logToPanel("[选区] 方法2成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                                    break;
                                } else {
                                    logToPanel("[选区] 方法2: selection属性存在但坐标无效", "warn");
                                }
                            } else {
                                logToPanel("[选区] 方法2: 未返回selection属性", "warn");
                            }
                        } catch (e2) { if (!_selLastErr) _selLastErr = e2; logToPanel("[选区] 方法2失败: " + (e2.message || e2), "warn"); }
                    }

                    // 方法3: 通过通道属性获取选区bounds
                    if (!_selOk) {
                        logToPanel("[选区] 尝试方法3: 通道属性获取选区bounds...", "info");
                        try {
                            var chResult = await app.batchPlay([{
                                _obj: "get",
                                _target: [{ _property: "bounds" }, { _ref: "channel", _enum: "channel", _value: "selection" }]
                            }], {});
                            _selProbeCompleted = true;
                            if (chResult && chResult[0] && chResult[0].bounds) {
                                var cb = chResult[0].bounds;
                                var cbL = cb.left._value || cb.left;
                                var cbT = cb.top._value || cb.top;
                                var cbR = cb.right._value || cb.right;
                                var cbB = cb.bottom._value || cb.bottom;
                                if ((cbR - cbL) > 0) {
                                    selBounds = {
                                        left: Math.round(cbL), top: Math.round(cbT),
                                        right: Math.round(cbR), bottom: Math.round(cbB),
                                        width: Math.round(cbR - cbL), height: Math.round(cbB - cbT)
                                    };
                                    _selOk = true;
                                    logToPanel("[选区] 方法3成功! 选区: " + selBounds.width + "x" + selBounds.height, "success");
                                    break;
                                } else {
                                    logToPanel("[选区] 方法3: bounds存在但无效", "warn");
                                }
                            } else {
                                logToPanel("[选区] 方法3: 未返回bounds属性", "warn");
                            }
                        } catch (e3) { if (!_selLastErr) _selLastErr = e3; logToPanel("[选区] 方法3失败: " + (e3.message || e3), "warn"); }
                    }

                    if (_selRetries > 0) {
                        await new Promise(function(r){ setTimeout(r, 200); });
                    }
                    _selRetries--;
                }

                // 三种接口全都抛错时，无法证明“没有选区”。这通常是 PS 忙、模态冲突、
                // 历史状态异常或 API 不可用，必须把真实故障交给上层，不能自动改成全图。
                if (!_selOk && !_selProbeCompleted && _selLastErr) {
                    var probeDetail = _selLastErr.message || String(_selLastErr);
                    var probeErr = new Error("选区检测失败: Photoshop 的三种选区接口都返回异常。最后错误: " + probeDetail);
                    probeErr.code = "SELECTION_DETECTION_FAILED";
                    throw probeErr;
                }

                if (!_selOk) {
                    if (state.getAutoSelectFullCanvasNoSelection()) {
                        var docW = Math.round(Number(doc.width) || 0);
                        var docH = Math.round(Number(doc.height) || 0);
                        if (docW > 0 && docH > 0) {
                            selBounds = {
                                left: 0, top: 0,
                                right: docW, bottom: docH,
                                width: docW, height: docH
                            };
                            _selOk = true;
                            logToPanel("[选区] 未检测到选区，已自动使用全图: " + docW + "x" + docH, "warn");
                        }
                    }
                }

                if (!_selOk) {
                    var errDetail = _selLastErr ? (_selLastErr.message || String(_selLastErr)) : "没有额外错误";
                    var bitInfo = "";
                    try { bitInfo = " | 文档位深: " + (doc.bitsPerChannel || "未知") + "bit"; } catch(be) {}
                    var modeInfo = "";
                    try { modeInfo = " | 色彩模式: " + (doc.mode || "未知"); } catch(me) {}
                    var diagMsg = "未检测到活动选区\n"
                        + "① 请确认已使用矩形选框工具(M)建立选区\n"
                        + "② 三种检测方式均未找到有效选区；最后一个接口提示: " + errDetail + "\n"
                        + "③ 文档信息" + bitInfo + modeInfo + "\n"
                        + "④ 如果是16/32bit文档，请尝试: 图像→模式→8位/通道";
                    throw new Error("NO_SELECTION|" + diagMsg);
                }
            }

            // 计算目标尺寸（限制maxResolution）
            var tw = selBounds.width, th = selBounds.height;
            var MAX_EDGE = state.getMaxResolution();
            if (tw > MAX_EDGE || th > MAX_EDGE) {
                if (tw > th) { th = Math.round(th * (MAX_EDGE / tw)); tw = MAX_EDGE; }
                else { tw = Math.round(tw * (MAX_EDGE / th)); th = MAX_EDGE; }
            }

            // ⚠⚠ 像素总量封顶（2026-09-14，修"超大选区 RangeError: Invalid array length"）
            //
            //   上面 MAX_EDGE 只管【最长边】。抠像把它设成 999999（用户要原始尺寸不缩），
            //   于是 8000×6000 这种选区会原样交给 getPixels → 后面 JS 编 PNG 要一口气
            //   申请好几份 100MB+ 的数组，UXP 的内存给不起，直接 RangeError。
            //
            //   ⭐ 解法就是 V6 那套"让 PS 自己缩"：getPixels 的 targetSize 比 sourceBounds 小时，
            //     缩放是 Photoshop 内部做的，JS 拿到的已经是小图。这里只是在 MAX_EDGE 之外
            //     再加一道【面积】上限：超过预算就把 targetSize 等比缩到预算内。
            //   ⚠ 不新建临时文档、不复制粘贴 —— 那条路多出一堆改文档状态的操作，
            //     而 targetSize 已经能达到同样效果，且是本文件跑了很久的老路。
            //   ⚠ 预算 2000 万像素 ≈ 5000×4000：RGB 60MB，编码链峰值约 6 倍 = 360MB，
            //     和设置里"4096"那档（50MB）在同一个量级。再大没实测过，别随手调高。
            var PIXEL_BUDGET = 20000000;
            var wantPixels = tw * th;
            if (wantPixels > PIXEL_BUDGET) {
                var k = Math.sqrt(PIXEL_BUDGET / wantPixels);
                var tw0 = tw, th0 = th;
                tw = Math.max(1, Math.round(tw * k));
                th = Math.max(1, Math.round(th * k));
                logToPanel("[超大选区] " + tw0 + "×" + th0 + " = " + (wantPixels / 1000000).toFixed(1)
                    + "M 像素，超过 " + (PIXEL_BUDGET / 1000000) + "M 的预算，由 Photoshop 内部缩到 "
                    + tw + "×" + th + " 再交出来（贴回时会拉回选区尺寸）", "warn");
            }

            // 检测文档位深度（16-bit/32-bit 需要特殊处理）
            var docBitDepth = 8;
            try {
                // 方法1: DOM属性 doc.bitsPerChannel
                var rawBpc = doc.bitsPerChannel;
                if (typeof rawBpc === 'number' && rawBpc > 0) {
                    docBitDepth = rawBpc;
                } else {
                    // 方法2: batchPlay 读取 depth 属性
                    var bpResult2 = await app.batchPlay([{
                        _obj: "get",
                        _target: [{ _property: "depth" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                    }], {});
                    if (bpResult2 && bpResult2[0] && bpResult2[0].depth) {
                        docBitDepth = bpResult2[0].depth;
                    }
                }
                // 方法3: batchPlay 读取 bitsPerChannel 属性（某些版本用此名）
                if (docBitDepth === 8 && rawBpc !== 8) {
                    try {
                        var bpResult3 = await app.batchPlay([{
                            _obj: "get",
                            _target: [{ _property: "bitsPerChannel" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
                        }], {});
                        if (bpResult3 && bpResult3[0] && bpResult3[0].bitsPerChannel) {
                            var bpcVal = bpResult3[0].bitsPerChannel;
                            // 可能是枚举值：_value: "bitDepth8" / "bitDepth16" / "bitDepth32"
                            if (typeof bpcVal === 'object' && bpcVal._value) {
                                if (bpcVal._value === 'bitDepth16' || bpcVal._value === 'sixteenBits') docBitDepth = 16;
                                else if (bpcVal._value === 'bitDepth32' || bpcVal._value === 'thirtyTwoBits') docBitDepth = 32;
                                else docBitDepth = 8;
                            } else if (typeof bpcVal === 'number') {
                                docBitDepth = bpcVal;
                            }
                        }
                    } catch(e3) {}
                }
            } catch(e) { docBitDepth = 8; }
            var is16bit = (docBitDepth === 16);
            var is32bit = (docBitDepth === 32);
            console.log("[imaging] 文档位深: " + docBitDepth + "-bit" + (is16bit ? " (16bit模式)" : is32bit ? " (32bit模式)" : ""));
            if (is16bit || is32bit) {
                logToPanel("[提示] 当前文档为 " + docBitDepth + "-bit 模式，自动转换为 8-bit 像素输出", "info");
            }

            // === 色彩稳定模式 自检 ===
            // 开启后:抓图强制转 sRGB、回传标记 sRGB、16/32位走色彩修正路径;此处先读文档色彩空间并把任何异常打进日志
            var csOn = false;
            try { csOn = !!state.getColorStable(); } catch(eCS) { csOn = false; }
            var csProfileName = '';
            if (csOn) {
                logToPanel("[色彩稳定] 模式已开启,开始自检...", "info");
                try {
                    // ⚠ 修崩溃(2026-07-10): 原来这里是"全量 get 文档"(不带 _property),
                    // PS 会连 printSettings 一起序列化 → 唤醒打印子系统枚举打印机 →
                    // 用户机器有坏打印机驱动时弹"打开打印机时出现错误"且点确定后 PS 崩溃。
                    // 改为只取 profile/mode 两个属性, 打印子系统不再被碰。
                    var bpProf = await app.batchPlay([
                        { _obj: "get", _target: [{ _property: "colorProfileName" }, { _ref: "document", _id: doc.id }] },
                        { _obj: "get", _target: [{ _property: "mode" }, { _ref: "document", _id: doc.id }] }
                    ], {});
                    var pf = bpProf && bpProf[0] ? (bpProf[0].colorProfileName !== undefined ? bpProf[0].colorProfileName : bpProf[0].profile) : null;
                    var md = bpProf && bpProf[1] ? bpProf[1].mode : null;
                    csProfileName = (typeof pf === 'string') ? pf : (pf && pf._value ? pf._value : '');
                    var modeName = (md && md._value) ? md._value : (typeof md === 'string' ? md : '未知');
                    logToPanel("[色彩稳定] 文档色彩空间: " + (csProfileName || '未读到') + " | 模式: " + modeName + " | 位深: " + docBitDepth + "-bit", "info");
                    if (csProfileName && csProfileName.indexOf('sRGB') === -1) {
                        logToPanel("[色彩稳定] ⚠ 文档非 sRGB(" + csProfileName + "),将在抓图时转 sRGB、回传时转回本空间(进出本应不偏)", "warn");
                    } else if (csProfileName && csProfileName.indexOf('sRGB') !== -1) {
                        logToPanel("[色彩稳定] ✓ 文档本身即 sRGB,色彩链路天然一致", "success");
                    }
                    if (modeName && modeName !== 'RGBColorMode' && modeName !== 'RGBColor' && modeName !== '未知') {
                        logToPanel("[色彩稳定] ⚠ 文档不是 RGB 模式(" + modeName + "),色彩稳定仅针对 RGB,当前模式结果以实拍为准", "warn");
                    }
                } catch(csReadErr) {
                    logToPanel("[色彩稳定] ✗ 自检读取文档色彩配置失败: " + (csReadErr.message || csReadErr) + " (不影响生成,但无法确认色彩空间)", "error");
                }
            }

            // 使用 imaging API 直接读取文档合成视图像素（零闪烁）
            // componentSize: 8 强制输出8bit，即使文档是16/32bit
            // ⚠ 超大选区的缩放已经在上面算 tw/th 时做掉了（PIXEL_BUDGET），这里不再分支
            var pixelData;
            try {
                var _gpOpts = {
                    documentID: doc.id,
                    sourceBounds: { left: selBounds.left, top: selBounds.top, right: selBounds.right, bottom: selBounds.bottom },
                    targetSize: { width: tw, height: th },
                    componentSize: 8,
                    colorSpace: "RGB",
                    applyAlpha: false
                };
                if (csOn) {
                    _gpOpts.colorProfile = "sRGB IEC61966-2.1";
                    logToPanel("[色彩稳定] 抓图请求 PS 将像素转为 sRGB IEC61966-2.1...", "info");
                }
                pixelData = await imaging.getPixels(_gpOpts);
                if (csOn) logToPanel("[色彩稳定] ✓ 抓图已按 sRGB 输出", "success");
            } catch(gpErr) {
                // 某些PS版本在16/32bit文档上 componentSize:8 会报错
                // 降级：不指定 componentSize，读取原始位深数据后手动转换
                if (csOn) logToPanel("[色彩稳定] ⚠ 带 sRGB 的抓图失败,进入降级路径: " + (gpErr.message || gpErr), "warn");
                if (is16bit || is32bit) {
                    console.log("[imaging] componentSize:8 失败 (" + gpErr.message + ")，降级读取原始位深数据...");
                    logToPanel("[兼容] componentSize:8 不支持此文档，使用降级读取方式", "warn");
                    var _gpOpts2 = {
                        documentID: doc.id,
                        sourceBounds: { left: selBounds.left, top: selBounds.top, right: selBounds.right, bottom: selBounds.bottom },
                        targetSize: { width: tw, height: th },
                        colorSpace: "RGB",
                        applyAlpha: false
                    };
                    if (csOn) _gpOpts2.colorProfile = "sRGB IEC61966-2.1";
                    pixelData = await imaging.getPixels(_gpOpts2);
                } else {
                    throw gpErr;
                }
            }
            // 兼容不同UXP版本的返回格式
            var imgObj = pixelData.imageData || pixelData;
            var comp = imgObj.components || 3;
            var pw = imgObj.width, ph = imgObj.height;
            // 检测实际返回的 componentSize
            var actualComponentSize = imgObj.componentSize || 8;
            console.log("[imaging] 像素数据: " + pw + "x" + ph + " comp=" + comp + " componentSize=" + actualComponentSize + " docBitDepth=" + docBitDepth);

            // 获取像素buffer（兼容getData方法和直接data属性）
            var rawBuf;
            if (typeof imgObj.getData === 'function') {
                rawBuf = await imgObj.getData({});
            } else {
                rawBuf = imgObj.data;
            }

            // 统一转换为 Uint8Array（处理各种返回类型）
            var pixels;
            var rawIsUint16 = (rawBuf instanceof Uint16Array);
            var rawIsFloat32 = (rawBuf instanceof Float32Array);
            if (rawBuf instanceof Uint8Array) {
                pixels = rawBuf;
            } else if (rawIsUint16) {
                // Uint16Array: 从16bit值转换为8bit
                // 注意: Photoshop 16-bit模式值域为 0-32768（不是标准的 0-65535）
                console.log("[imaging] 返回类型: Uint16Array, 长度=" + rawBuf.length);
                var expectedPixelCount = pw * ph * comp;
                // 采样检测实际值域：PS用0-32768，标准用0-65535
                var maxSampleVal = 0;
                var sampleLimit = Math.min(rawBuf.length, 5000);
                for (var smi = 0; smi < sampleLimit; smi++) {
                    if (rawBuf[smi] > maxSampleVal) maxSampleVal = rawBuf[smi];
                }
                var isPS32768Range = (maxSampleVal > 0 && maxSampleVal <= 32769);
                console.log("[imaging] 16bit值域检测: maxSample=" + maxSampleVal + " isPS32768=" + isPS32768Range);
                var pixels8from16 = new Uint8Array(expectedPixelCount);
                if (isPS32768Range) {
                    // PS范围 0-32768 → 0-255
                    for (var u16i = 0; u16i < expectedPixelCount && u16i < rawBuf.length; u16i++) {
                        pixels8from16[u16i] = Math.min(255, Math.round(rawBuf[u16i] * 255 / 32768));
                    }
                    logToPanel("[兼容] 16-bit (PS 0-32768) → 8-bit 转换完成", "success");
                } else {
                    // 标准范围 0-65535 → 0-255
                    for (var u16i2 = 0; u16i2 < expectedPixelCount && u16i2 < rawBuf.length; u16i2++) {
                        pixels8from16[u16i2] = Math.min(255, (rawBuf[u16i2] + 128) >> 8);
                    }
                    logToPanel("[兼容] 16-bit (标准 0-65535) → 8-bit 转换完成", "success");
                }
                pixels = pixels8from16;
                if (csOn) logToPanel("[色彩稳定] ⚠ 16-bit 值域靠采样推断(" + (isPS32768Range ? "PS 0-32768" : "标准 0-65535") + "),极暗图可能误判致偏亮,结果以实拍为准", "warn");
            } else if (rawIsFloat32) {
                // Float32Array: 32-bit浮点（0.0-1.0）转换为8bit
                console.log("[imaging] 返回类型: Float32Array, 长度=" + rawBuf.length);
                var expectedPixelCount32 = pw * ph * comp;
                var pixels8from32 = new Uint8Array(expectedPixelCount32);
                if (csOn) {
                    // 色彩稳定:32-bit 文档为线性光,直接*255会整体偏暗;此处补 sRGB gamma 编码(OETF)
                    for (var f32i = 0; f32i < expectedPixelCount32 && f32i < rawBuf.length; f32i++) {
                        var lv = rawBuf[f32i];
                        if (lv < 0) lv = 0; if (lv > 1) lv = 1;
                        var sv = (lv <= 0.0031308) ? (lv * 12.92) : (1.055 * Math.pow(lv, 1 / 2.4) - 0.055);
                        pixels8from32[f32i] = Math.max(0, Math.min(255, Math.round(sv * 255)));
                    }
                    logToPanel("[色彩稳定] 32-bit 线性光 → sRGB gamma → 8-bit (已修正偏暗)", "success");
                } else {
                    for (var f32i = 0; f32i < expectedPixelCount32 && f32i < rawBuf.length; f32i++) {
                        var fval = rawBuf[f32i];
                        if (fval < 0) fval = 0;
                        if (fval > 1) fval = 1;
                        pixels8from32[f32i] = Math.round(fval * 255);
                    }
                    logToPanel("[兼容] 32-bit Float32 → 8-bit 转换完成", "success");
                }
                pixels = pixels8from32;
            } else if (rawBuf instanceof ArrayBuffer) {
                pixels = new Uint8Array(rawBuf);
            } else if (rawBuf && rawBuf.buffer) {
                pixels = new Uint8Array(rawBuf.buffer);
            } else {
                pixels = new Uint8Array(rawBuf);
            }

            // 二次检测：即使传了 Uint8Array，长度可能是16bit的（某些PS版本忽略componentSize:8）
            var expectedLen8 = pw * ph * comp;
            var expectedLen16 = pw * ph * comp * 2;
            if (!rawIsUint16 && !rawIsFloat32 && pixels.length === expectedLen16 && pixels.length !== expectedLen8) {
                console.log("[imaging] 检测到16bit字节数据（长度=" + pixels.length + "，期望8bit长度=" + expectedLen8 + "），正在转换...");
                var pixels8conv = new Uint8Array(expectedLen8);
                // 检测字节序：采样前几个像素，判断大端还是小端
                // 大端(BE): [high, low] → high字节更有意义
                // 小端(LE): [low, high] → high在第二个字节
                var sumEven = 0, sumOdd = 0;
                var sampleCount = Math.min(100, expectedLen8);
                for (var si = 0; si < sampleCount; si++) {
                    sumEven += pixels[si * 2];       // 偶数位
                    sumOdd += pixels[si * 2 + 1];    // 奇数位
                }
                // 如果偶数位的平均值明显更大 → 大端；否则 → 小端
                var isBigEndian = (sumEven >= sumOdd);
                var highByteOffset = isBigEndian ? 0 : 1;
                console.log("[imaging] 字节序检测: " + (isBigEndian ? "Big-Endian" : "Little-Endian") + " (even=" + sumEven + " odd=" + sumOdd + ")");
                // 组合两个字节为完整16bit值，再判断PS范围(0-32768)还是标准范围(0-65535)
                var maxVal16b = 0;
                var checkLimit = Math.min(5000, expectedLen8);
                for (var ci = 0; ci < checkLimit; ci++) {
                    var hb = pixels[ci * 2 + (isBigEndian ? 0 : 1)];
                    var lb = pixels[ci * 2 + (isBigEndian ? 1 : 0)];
                    var v16 = (hb << 8) | lb;
                    if (v16 > maxVal16b) maxVal16b = v16;
                }
                var isPS16bRange = (maxVal16b > 0 && maxVal16b <= 32769);
                console.log("[imaging] 字节16bit值域: maxVal=" + maxVal16b + " isPS32768=" + isPS16bRange);
                for (var bi = 0; bi < expectedLen8; bi++) {
                    var hiB = pixels[bi * 2 + (isBigEndian ? 0 : 1)];
                    var loB = pixels[bi * 2 + (isBigEndian ? 1 : 0)];
                    var val16b = (hiB << 8) | loB;
                    if (isPS16bRange) {
                        pixels8conv[bi] = Math.min(255, Math.round(val16b * 255 / 32768));
                    } else {
                        pixels8conv[bi] = Math.min(255, (val16b + 128) >> 8);
                    }
                }
                pixels = pixels8conv;
                logToPanel("[兼容] 16-bit 字节数据 → 8-bit 转换完成 (" + (isBigEndian ? "BE" : "LE") + ", " + (isPS16bRange ? "PS 0-32768" : "标准 0-65535") + ")", "success");
                if (csOn) logToPanel("[色彩稳定] ⚠ 16-bit 字节值域靠采样推断,极暗图可能误判致偏亮,结果以实拍为准", "warn");
            }

            // 最终长度校验
            if (pixels.length !== expectedLen8) {
                console.warn("[imaging] 像素长度不匹配! 实际=" + pixels.length + " 期望=" + expectedLen8 + " (可能是32bit或其他格式)");
                // 尝试截取或填充
                if (pixels.length > expectedLen8) {
                    pixels = pixels.subarray(0, expectedLen8);
                    logToPanel("[兼容] 像素数据已截取到正确长度", "warn");
                } else {
                    var padded = new Uint8Array(expectedLen8);
                    padded.set(pixels);
                    pixels = padded;
                    logToPanel("[兼容] 像素数据已填充到正确长度", "warn");
                }
            }

            console.log("[imaging] pixels长度=" + pixels.length + " 期望=" + expectedLen8 + " 首像素=[" + pixels[0] + "," + pixels[1] + "," + pixels[2] + "]");
            // 自动扩充+裁切: 补白凑方(在抗截断之前 — 等价于用户手动扩好画布再走原流程)
            // 容差 1%: 差一两像素的"准方形"不折腾
            if (opts && opts.padToSquare && pw > 0 && ph > 0
                && Math.abs(pw - ph) / Math.max(pw, ph) > 0.01) {
                var _pad = padPixelsToSquare(pixels, pw, ph, comp);
                pixels = _pad.pixels;
                // 文档坐标系的虚拟方形框: 以原选区为中心外扩(可越出画布, PS 允许图层出界)
                var _sideDoc = Math.max(selBounds.width, selBounds.height);
                var _sqLeft = Math.round(selBounds.left - (_sideDoc - selBounds.width) / 2);
                var _sqTop = Math.round(selBounds.top - (_sideDoc - selBounds.height) / 2);
                var _origSel = {
                    left: selBounds.left, top: selBounds.top,
                    right: selBounds.right, bottom: selBounds.bottom,
                    width: selBounds.width, height: selBounds.height
                };
                selBounds = {
                    left: _sqLeft, top: _sqTop,
                    right: _sqLeft + _sideDoc, bottom: _sqTop + _sideDoc,
                    width: _sideDoc, height: _sideDoc,
                    _docW: selBounds._docW, _docH: selBounds._docH,
                    cropRect: _origSel   // 贴回时按它加蒙版, 裁掉白边
                };
                logToPanel("[扩充裁切] 选区 " + pw + "x" + ph + " → 补白成 " + _pad.side + "x" + _pad.side + " (贴回自动裁白)", "info");
                pw = _pad.side;
                ph = _pad.side;
            }
            // 保留一份用户可见的正常原图。抗截断只应作用于发送给 Banana 的副本，
            // 不能让任务主卡片误用偏移/翻转后的内部输入图。普通模式不复制整块像素，
            // 直接一次编码并同时作为原图和输入图，降低 3K/4K 抓取的内存峰值。
            var antiMode = Number(state.getAntiTruncationMode()) || 0;
            var originalBase64, resultBase64;
            var formatLabel = 'PNG';
            if (antiMode > 0) {
                var originalPixels = new pixels.constructor(pixels);
                var originalPngBytes = encodePNGFromRGB(pw, ph, originalPixels, comp, csOn);
                originalBase64 = arrayBufferToBase64(originalPngBytes.buffer);
                pixelsHueShift180(pixels, pw * ph, comp);
                if (antiMode === 2) {
                    pixelsFlipVertical(pixels, pw, ph, comp);
                }
                var pngBytes = encodePNGFromRGB(pw, ph, pixels, comp, csOn);
                resultBase64 = arrayBufferToBase64(pngBytes.buffer);
            } else {
                var plainPngBytes = encodePNGFromRGB(pw, ph, pixels, comp, csOn);
                resultBase64 = arrayBufferToBase64(plainPngBytes.buffer);
                originalBase64 = resultBase64;
            }
            if (csOn) logToPanel("[色彩稳定] ✓ 传出 PNG 已写入 sRGB 标记", "success");
            var rawSizeKB = (pixels.length / 1024).toFixed(1);
            var b64SizeKB = (resultBase64.length / 1024).toFixed(1);
            logToPanel("[图像] " + pw + "x" + ph + " | 格式:" + formatLabel + " | 原始RGB:" + rawSizeKB + "KB → 实际传输:" + b64SizeKB + "KB", "info");
            result = { base64: resultBase64, originalBase64: originalBase64, selection: selBounds, pixelWidth: pw, pixelHeight: ph };
            // 释放imaging资源
            try { if (imgObj.dispose) imgObj.dispose(); } catch(e) {}
            try { if (pixelData.imageData && pixelData.imageData.dispose) pixelData.imageData.dispose(); } catch(e) {}
        }, { commandName: "抓取选区图片" });
    } catch (e) {
        // ⭐ 10-25（遥测 7 天 877 次「抓取选区时出错」里 873 次其实是没框选区，docs/286 P0-4）：
        //   executeAsModal 有时把里面抛的 Error 变成一串文字「Error: NO_SELECTION|…」再抛出来 ——
        //   原来只认 e.message 开头，字符串认不出 ⇒ 掉到下面兜底，报成「抓取选区时出错，换图或重启 PS」。
        var noSelText = typeof e === "string" ? e : (e && e.message) || "";
        noSelText = String(noSelText).replace(/^\s*(Error:\s*)+/, "");
        if (noSelText.indexOf("NO_SELECTION") === 0) {
            var parts = noSelText.split("|");
            if (parts.length > 1) {
                logToPanel("[选区] " + parts[1], "error");
            }
            getSelectionAndImage.lastError = { code: 'NO_SELECTION', message: parts.slice(1).join('|') || '未检测到选区' };
            return null;
        }
        if (e && e.code === "SELECTION_DETECTION_FAILED") {
            getSelectionAndImage.lastError = { code: e.code, message: e.message || '选区检测失败' };
            logToPanel("[错误] " + getSelectionAndImage.lastError.message, "error");
            throw e;
        }
        if (e && e.message && e.message.includes("选区")) throw e;

        // 兜底: 异常对象可能没有 .message (executeAsModal/imaging API 抛的某些 PSError 是这样)
        var errStr;
        if (!e) {
            errStr = "(异常对象为空)";
        } else if (e instanceof Error) {
            errStr = e.message || e.name || e.code || "(Error 对象但无 message/name/code)";
        } else if (typeof e === 'string') {
            errStr = e;
        } else if (typeof e === 'object') {
            // PSError 等自定义对象: 把所有可读字段拼出来
            var fields = [];
            try { if (e.message != null) fields.push("message=" + e.message); } catch(_) {}
            try { if (e.name != null) fields.push("name=" + e.name); } catch(_) {}
            try { if (e.code != null) fields.push("code=" + e.code); } catch(_) {}
            try { if (e.number != null) fields.push("number=" + e.number); } catch(_) {}
            try { if (e.description != null) fields.push("description=" + e.description); } catch(_) {}
            if (fields.length === 0) {
                try { errStr = JSON.stringify(e); } catch(_) { errStr = "(无法序列化的异常对象)"; }
            } else {
                errStr = fields.join(" | ");
            }
        } else {
            errStr = String(e);
        }

        console.error("[getSelectionAndImage] 错误:", errStr, e);
        logToPanel("[错误] 选区抓取异常: " + errStr, "error");
        getSelectionAndImage.lastError = { code: 'CAPTURE_FAILED', message: '选区抓取失败: ' + errStr };

        // 诊断: 重新从 app.activeDocument 拿 (catch 块外层 doc 变量不可见)
        try {
            var _docNow = app.activeDocument;
            if (_docNow) {
                var _diag = [];
                try { _diag.push("位深:" + (_docNow.bitsPerChannel || "?") + "bit"); } catch(x) {}
                try { _diag.push("模式:" + (_docNow.mode || "?")); } catch(x) {}
                try { _diag.push("尺寸:" + _docNow.width + "x" + _docNow.height); } catch(x) {}
                try { _diag.push("文档名:" + _docNow.name); } catch(x) {}
                if (_diag.length > 0) logToPanel("[诊断] " + _diag.join(" | "), "warn");
            } else {
                logToPanel("[诊断] 当前没有活动文档 (app.activeDocument 为空)", "warn");
            }
        } catch(diagErr) {}

        // 只有明确的 NO_SELECTION 才返回 null。其余 Photoshop / imaging 异常必须
        // 交给上层任务处理器展示，否则调用方会把所有故障误报成“未检测到选区”。
        var captureErr = new Error("选区抓取失败: " + errStr);
        captureErr.code = "SELECTION_CAPTURE_FAILED";
        throw captureErr;
    }
    return result;
}

// 回图默认使用 B / restore。用户真实 PSD 已确认：多图层、仅一个可见且
// 选中该层时，A 会改变原层显隐，B 正常。保护所有调用，避免只数顶层造成
// 嵌套组漏判；只恢复发生变化的旧层，新输出不在恢复范围内。
// legacy / anchor 仍可显式选择，用于 A / C 对照，不移除任何实验入口。
function returnStrategy(options) {
    var value = options && options.strategy;
    if (value == null || value === '') return 'restore';
    if (value === 'legacy' || value === 'restore' || value === 'anchor') return value;
    throw returnStateError('RETURN_STRATEGY_INVALID', '未知的回图实验策略', { stage: 'prepare', strategy: String(value) });
}

function returnStateError(code, message, details) {
    var e = new Error(message || code);
    e.code = code;
    e.returnStage = details && details.stage;
    if (details) e.returnDetails = details;
    return e;
}

// ⭐ 2026-10-21（docs/261 B8）：PS 自己说的拒绝原因存在 returnDetails.cause / result 里，以前没进报错详情 ——
//   用户和我们只能看到「Photoshop 拒绝回图操作: place」，不知道 PS 为什么拒绝。现在拼进消息里，几种常见的翻成人话。
function psRefusalWords(result, cause) {
    var n = Number(result), c = String(cause == null ? '' : cause);
    if (n === -128 || /cancel/i.test(c)) return 'Photoshop 那边被取消了（可能弹着对话框，或者按了 Esc）';
    if (/modal|busy|another|not available|unavailable/i.test(c)) return 'Photoshop 正忙（开着对话框或者正在执行别的操作），关掉再试';
    if (/ACTION_RECEIPT_MISSING/.test(c)) return 'Photoshop 没有给回执';
    if (c && c !== 'undefined' && c !== 'null') return 'Photoshop 原话：' + c.slice(0, 160) + (Number.isFinite(n) && String(n) !== c ? '，结果码 ' + n : '');
    return Number.isFinite(n) ? 'Photoshop 结果码 ' + n : '';
}
function returnErrorText(e) {
    var msg = String(e && e.message || e);
    var d = e && e.returnDetails;
    var why = psRefusalWords(e && e.result, d && d.cause);
    return why && msg.indexOf(why) < 0 ? msg + '（' + why + '）' : msg;
}

// Adobe 的 Documents 集合是 array-like；官方合同保证 length/index/forEach，
// 不保证 Array.prototype.find。回图诊断和显隐恢复必须用索引读取，避免
// 模拟数组能过、真实 UXP 集合却在 B/C 策略入口直接抛 "find is not a function"。
function findDocumentById(docId) {
    var documents = app && app.documents;
    if (!documents || !Number.isFinite(Number(documents.length))) return null;
    for (var i = 0; i < documents.length; i++) {
        var document = documents[i];
        if (document && Number(document.id) === Number(docId)) return document;
    }
    return null;
}

function walkLayers(layers, output) {
    if (!layers || !Number.isFinite(Number(layers.length))) throw new Error('LAYER_COLLECTION_UNAVAILABLE');
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (!layer || !Number.isSafeInteger(Number(layer.id)) || Number(layer.id) < 1 || typeof layer.visible !== 'boolean') throw new Error('LAYER_VISIBILITY_UNAVAILABLE');
        output.push({ id: Number(layer.id), visible: layer.visible });
        // UXP 的集合是 array-like，不能要求 Array.isArray 或 .map。
        // Adobe Layer.layers 只对组图层定义。普通图层的 getter 在部分宿主
        // 会抛错，不能为了检查有没有子层而先读取该 getter。
        var kind = layer.kind;
        var groupKind = constants.LayerKind && constants.LayerKind.GROUP;
        var isGroup = (groupKind != null && kind === groupKind) || String(kind || '').toLowerCase() === 'group';
        if (isGroup) walkLayers(layer.layers, output);
        else if (kind == null || (typeof kind === 'number' && groupKind == null)) {
            // 兼容未提供 LayerKind 常量的旧依赖/测试；无法读取时明确失败，
            // 不能将无法确认的子层静默漏出可见性快照。
            var children = layer.layers;
            if (children != null) walkLayers(children, output);
        }
    }
}

function captureReturnVisibility(doc) {
    var rows = [];
    try { walkLayers(doc && doc.layers, rows); } catch (e) {
        if (e && e.code) throw e;
        throw returnStateError('RETURN_VISIBILITY_READ_FAILED', '无法读取 Photoshop 原有图层可见状态', { stage: 'visibility-read', cause: String(e && e.message || e) });
    }
    if (!rows.length) throw returnStateError('RETURN_VISIBILITY_READ_FAILED', '目标文档没有可读取的原有图层状态', { stage: 'visibility-read' });
    return rows;
}

async function checkedReturnBatch(descriptors, stage) {
    var result = await app.batchPlay(descriptors, {});
    var bad = Array.isArray(result) && result.find(function(row) { return row && (String(row._obj || '').toLowerCase() === 'error' || Number(row.result) < 0); });
    var missing = Array.isArray(result) && result.some(function(row) { return !row || typeof row !== 'object'; });
    if (!Array.isArray(result) || result.length !== descriptors.length || missing || bad) {
        var err = returnStateError('RETURN_PS_ACTION_FAILED', 'Photoshop 拒绝回图操作: ' + stage, { stage: stage, cause: bad && (bad.message || bad.result) || 'ACTION_RECEIPT_MISSING' });
        if (bad) { err.raw = bad; if (Number.isFinite(Number(bad.result))) err.result = Number(bad.result); }
        throw err;
    }
    return result;
}

async function restoreReturnVisibility(docId, snapshot) {
    if (!Array.isArray(snapshot)) throw returnStateError('RETURN_VISIBILITY_RESTORE_FAILED', '没有可恢复的 Photoshop 图层可见状态', { stage: 'visibility-restore' });
    try {
        var doc = findDocumentById(docId);
        if (!doc) throw new Error('SOURCE_DOCUMENT_CLOSED');
        var current = captureReturnVisibility(doc);
        var byId = new Map(current.map(function(row) { return [row.id, row]; }));
        var changed = 0;
        for (var i = 0; i < snapshot.length; i++) {
            var row = snapshot[i];
            var actual = byId.get(row.id);
            if (!actual) throw new Error('ORIGINAL_LAYER_MISSING:' + row.id);
            if (actual.visible === row.visible) continue;
            // 显式 show/hide，绝不使用 toggle 或独显动作；只触碰快照中已有的图层。
            await checkedReturnBatch([{ _obj: row.visible ? 'show' : 'hide', _target: [{ _ref: 'layer', _id: Number(row.id) }, { _ref: 'document', _id: Number(docId) }] }], 'visibility-restore');
            changed++;
        }
        var verified = new Map(captureReturnVisibility(doc).map(function(row) { return [row.id, row]; }));
        var drift = snapshot.filter(function(row) { var actual = verified.get(row.id); return !actual || actual.visible !== row.visible; });
        if (drift.length) throw new Error('ORIGINAL_VISIBILITY_MISMATCH:' + drift.map(function(row) { return row.id; }).join(','));
        return { restored: true, changed: changed, checked: snapshot.length };
    } catch (e) {
        throw returnStateError('RETURN_VISIBILITY_RESTORE_FAILED', '恢复 Photoshop 原有图层可见状态失败', { stage: 'visibility-restore', cause: String(e && e.message || e) });
    }
}

async function checkpointReturn(options, stage, doc) {
    if (!options || typeof options.checkpoint !== 'function') return;
    try { await options.checkpoint(stage, doc); } catch (e) {
        throw returnStateError('RETURN_CHECKPOINT_FAILED', '回图诊断检查点失败: ' + String(e && e.message || e), { stage: stage, cause: String(e && e.message || e) });
    }
}

async function placeImageToSpecificDoc(base64Str, targetDocId, targetSelection, antiMode, layerType, returnOptions) {
    var rawFile = await _writePlaceTempFile(base64Str);
    var createdLayerId = null;
    try {
        await core.executeAsModal(async function(executionContext) {
            var suspensionID = null;
            var receipt = returnOptions && returnOptions.receipt;
            try {
                if (returnOptions && returnOptions.historyName) {
                    try {
                        suspensionID = await executionContext.hostControl.suspendHistory({ documentID: Number(targetDocId), name: String(returnOptions.historyName).slice(0, 100) });
                        if (receipt) receipt.historyGrouped = suspensionID != null;
                    } catch (eHistory) {
                        if (receipt) { receipt.historyGrouped = false; receipt.historyError = String(eHistory && eHistory.message || eHistory); }
                        logToPanel('[回图诊断] 历史合并不可用: ' + String(eHistory && eHistory.message || eHistory), 'warn');
                    }
                }
                createdLayerId = await _placeCoreInModal(rawFile, targetDocId, targetSelection, antiMode, layerType, returnOptions);
            } finally {
                if (suspensionID != null) {
                    try { await executionContext.hostControl.resumeHistory(suspensionID); }
                    catch (eResume) { if (receipt) { receipt.historyGrouped = false; receipt.historyResumeError = String(eResume && eResume.message || eResume); } logToPanel('[回图诊断] 历史恢复失败: ' + String(eResume && eResume.message || eResume), 'warn'); }
                }
            }
        }, { commandName: "贴回图片" });
        return createdLayerId;
    } finally {
        try { await rawFile.delete(); } catch (_) {}
    }
}

// ── 急速回图(v6.5.8): 拆分出的两块积木, 供批量单权限模式复用 ──
// 1) 写临时文件(含色彩稳定 sRGB 注入) — 不占修改权时间, 批量时可提前全部写好
async function _writePlaceTempFile(base64Str) {
    var tempFolder = await fs.getTemporaryFolder();
    var ts = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    var rawFile = await tempFolder.createFile("temp_raw_" + ts + ".png", { overwrite: true });
    // 色彩稳定:给 AI 回传的 PNG 注入 sRGB 标记,PS 置入时会自动从 sRGB 转换到文档工作空间(避免回传偏色)
    var _rawBytes = base64ToArrayBuffer(base64Str);
    var _csOnPlace = false;
    try { _csOnPlace = !!state.getColorStable(); } catch(eCSP) { _csOnPlace = false; }
    if (_csOnPlace) {
        try {
            var _u8 = new Uint8Array(_rawBytes);
            if (_u8.length > 8 && _u8[0] === 137 && _u8[1] === 80 && _u8[2] === 78 && _u8[3] === 71) {
                var _tagged = injectSRGBChunkIntoPNG(_u8);
                _rawBytes = _tagged.buffer.slice(_tagged.byteOffset, _tagged.byteOffset + _tagged.byteLength);
                logToPanel("[色彩稳定] ✓ 回传图已标记 sRGB,PS 将自动转换到文档色彩空间", "info");
            } else {
                logToPanel("[色彩稳定] ⚠ 回传图非 PNG(疑为 JPEG),本版不注入色彩标记;若文档非 sRGB 回传端可能仍偏色,建议传出格式用 PNG", "warn");
            }
        } catch(_csPlaceErr) {
            logToPanel("[色彩稳定] ✗ 回传图 sRGB 标记注入失败: " + (_csPlaceErr.message || _csPlaceErr) + " (改用原始字节置入)", "error");
            _rawBytes = base64ToArrayBuffer(base64Str);
        }
    }
    await rawFile.write(_rawBytes, { format: storage.formats.binary });
    return rawFile;
}

// 2) 置入内核 — ⚠ 必须已在 executeAsModal 内调用(自己不申请修改权)。
//    逻辑与原 placeImageToSpecificDoc 的 modal 体完全一致, 原样搬移。
async function _placeCoreInModal(rawFile, targetDocId, targetSelection, antiMode, layerType, returnOptions) {
        var strategy = returnStrategy(returnOptions);
        var visibilitySnapshot = null;
        var anchorId = null;
        var placedLayerId = null;
        var operationError = null;
        var completed = false;
        var outcome = returnOptions && returnOptions.receipt && typeof returnOptions.receipt === 'object' ? returnOptions.receipt : {};
        // 正式保护策略和带诊断回执/检查点的 legacy 对照都检查 Photoshop
        // 错误 descriptor；只有显式且无诊断回执的 legacy 保留宽松旧行为。
        var strictDiagnostic = strategy !== 'legacy' || !!(returnOptions && (returnOptions.receipt || typeof returnOptions.checkpoint === 'function' || Array.isArray(returnOptions.receipts)));
        outcome.strategy = strategy;
        outcome.docId = Number(targetDocId);
        outcome.layerId = null;
        outcome.placementOccurred = false;
        outcome.placementAttempted = false;
        outcome.placementUncertain = false;
        outcome.visibilityRestored = strategy === 'legacy' ? null : false;
        outcome.anchorId = null;
        outcome.anchorRemoved = null;
        outcome.errors = [];
        outcome.stage = 'prepare';
        async function action(descriptors, stage) {
            outcome.stage = stage;
            if (strictDiagnostic) return checkedReturnBatch(descriptors, stage);
            return app.batchPlay(descriptors, {});
        }
        try {
        var targetDoc = findDocumentById(targetDocId);
        if (!targetDoc) {
            var targetErr = new Error("来源文档已关闭，无法传回");
            targetErr.code = "SOURCE_DOCUMENT_CLOSED";
            throw targetErr;
        }
        // 严格诊断的 legacy 对照也要记录原有 ID：它不做 restore，但不能在
        // place 没有创建新层时把原活动层误当成回图层继续变换。
        if (strategy !== 'legacy' || strictDiagnostic) visibilitySnapshot = captureReturnVisibility(targetDoc);
        await checkpointReturn(returnOptions, 'modal-entry', targetDoc);

        // === Step 1: 切到目标文档 ===
        await action([{ _obj: "select", _target: [{ _ref: "document", _id: targetDocId }] }], 'select-document');
        await checkpointReturn(returnOptions, 'select-document', targetDoc);
        // anchor 刻意不走 select-front，用于区分该动作是否触发宿主独显副作用。
        if (strategy !== 'anchor') {
            await action([{ _obj: "select", _target: [{ _ref: "layer", _enum: "ordinal", _value: "front" }], makeVisible: false }], 'select-front');
            await checkpointReturn(returnOptions, 'select-front', targetDoc);
        }

        // anchor 策略把 placeEvent 的插入点固定在一个由本次回图创建的透明层上，
        // 避免 Photoshop 把当前唯一可见图层当成隐式独显上下文。该层只属于本次调用，
        // 无论成功还是失败都会在 finally 中按 ID 删除。
        if (strategy === 'anchor') {
            var anchorResult = await action([{
                _obj: 'make', _target: [{ _ref: 'layer' }],
                using: { _obj: 'layer', name: '__V7_RETURN_ANCHOR__' }
            }], 'anchor-create');
            anchorId = anchorResult && anchorResult[0] && (anchorResult[0].layerID || anchorResult[0].layerId);
            if (!anchorId) { try { anchorId = app.activeDocument.activeLayers[0] && app.activeDocument.activeLayers[0].id; } catch (_) {} }
            if (!Number.isSafeInteger(Number(anchorId)) || Number(anchorId) < 1 || visibilitySnapshot.some(function(row) { return row.id === Number(anchorId); })) {
                anchorId = null;
                throw returnStateError('RETURN_ANCHOR_CREATE_FAILED', '无法确认回图锚点是新建图层，已停止后续删除操作', { stage: 'anchor-create' });
            }
            outcome.anchorId = Number(anchorId);
            outcome.anchorRemoved = false;
            await action([
                { _obj: 'move', _target: [{ _ref: 'layer', _id: Number(anchorId) }, { _ref: 'document', _id: Number(targetDocId) }], to: { _ref: 'layer', _enum: 'ordinal', _value: 'front' } },
                { _obj: 'select', _target: [{ _ref: 'layer', _id: Number(anchorId) }, { _ref: 'document', _id: Number(targetDocId) }], makeVisible: false }
            ], 'anchor-place');
            // ⚠ 2026-10-15：UXP 图层集合不是真数组，Array.prototype.some.call 会把每一项都跳过 → 恒为 false。逐个读。
            outcome.anchorTopLevel = (function() {
                var coll = targetDoc.layers;
                try { for (var i = 0; coll && i < coll.length; i++) { var layer = coll[i]; if (layer && Number(layer.id) === Number(anchorId)) return true; } } catch (_) {}
                return false;
            })();
            if (!outcome.anchorTopLevel) throw returnStateError('RETURN_ANCHOR_NOT_TOP_LEVEL', 'Photoshop 未将回图锚点移出原编组，已停止置入', { stage: 'anchor-place', anchorId: Number(anchorId) });
            await checkpointReturn(returnOptions, 'anchor-create', targetDoc);
        }

        // === Step 2: 用 placeEvent 直接置入原始文件（无需打开临时文档） ===
        var placeToken = await fs.createSessionToken(rawFile);
        outcome.placementAttempted = true;
        await action([{
            _obj: "placeEvent",
            null: { _path: placeToken, _kind: "local" },
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
        }], 'place');
        // 置入命令已被 Photoshop 接受，即便后续图层 ID/几何读取失败也不能当作
        // “肯定没有置入”重发，否则会在用户文档中创建重复结果。
        outcome.placementOccurred = true;
        try { placedLayerId = app.activeDocument.activeLayers[0] && app.activeDocument.activeLayers[0].id; } catch (_) {}
        if (strictDiagnostic && (!Number.isSafeInteger(Number(placedLayerId)) || Number(placedLayerId) < 1 || Number(placedLayerId) === Number(anchorId) || (visibilitySnapshot && visibilitySnapshot.some(function(row) { return row.id === Number(placedLayerId); })))) {
            throw returnStateError('RETURN_LAYER_RECEIPT_FAILED', 'Photoshop 没有返回可确认的新建回图层编号', { stage: 'place' });
        }
        outcome.layerId = placedLayerId == null ? null : Number(placedLayerId);
        await checkpointReturn(returnOptions, 'place', targetDoc);
        // placeEvent 自动选中新建的智能对象图层

        // === Step 3: 精确定位到选区位置（分步操作避免偏移） ===
        if (targetSelection) {
            // 获取置入图层的当前 bounds（使用 boundsNoEffects 避免图层效果干扰）
            var boundsResult = await action([{
                _obj: "get",
                _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], 'bounds');
            var curLeft = 0, curTop = 0, curWidth = 0, curHeight = 0;
            if (boundsResult && boundsResult[0] && boundsResult[0].boundsNoEffects) {
                var b = boundsResult[0].boundsNoEffects;
                curLeft = (b.left && b.left._value !== undefined) ? b.left._value : (b.left || 0);
                curTop = (b.top && b.top._value !== undefined) ? b.top._value : (b.top || 0);
                var bRight = (b.right && b.right._value !== undefined) ? b.right._value : (b.right || 0);
                var bBottom = (b.bottom && b.bottom._value !== undefined) ? b.bottom._value : (b.bottom || 0);
                curWidth = bRight - curLeft;
                curHeight = bBottom - curTop;
            }
            // 降级：如果 boundsNoEffects 失败，用普通 bounds
            if (curWidth <= 0 || curHeight <= 0) {
                var boundsResult2 = await action([{
                    _obj: "get",
                    _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                }], 'bounds-fallback');
                if (boundsResult2 && boundsResult2[0] && boundsResult2[0].bounds) {
                    var b2 = boundsResult2[0].bounds;
                    curLeft = (b2.left && b2.left._value !== undefined) ? b2.left._value : (b2.left || 0);
                    curTop = (b2.top && b2.top._value !== undefined) ? b2.top._value : (b2.top || 0);
                    var b2Right = (b2.right && b2.right._value !== undefined) ? b2.right._value : (b2.right || 0);
                    var b2Bottom = (b2.bottom && b2.bottom._value !== undefined) ? b2.bottom._value : (b2.bottom || 0);
                    curWidth = b2Right - curLeft;
                    curHeight = b2Bottom - curTop;
                }
            }
            console.log("[贴图] 当前图层bounds: left=" + curLeft + " top=" + curTop + " w=" + curWidth + " h=" + curHeight);
            console.log("[贴图] 目标选区: left=" + targetSelection.left + " top=" + targetSelection.top + " w=" + targetSelection.width + " h=" + targetSelection.height);

            // Step 3a: 先缩放到目标尺寸（从左上角缩放）
            if (curWidth > 0 && curHeight > 0) {
                var scaleX = (targetSelection.width / curWidth) * 100;
                var scaleY = (targetSelection.height / curHeight) * 100;
                if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
                    await action([{
                        _obj: "transform",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
                        width: { _unit: "percentUnit", _value: scaleX },
                        height: { _unit: "percentUnit", _value: scaleY },
                        interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
                    }], 'scale');
                }
            }
            await checkpointReturn(returnOptions, 'scale', targetDoc);

            // Step 3b: 再精确移动到目标位置（读取缩放后的实际bounds）
            var newBoundsResult = await action([{
                _obj: "get",
                _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], 'bounds-after-scale');
            var newLeft = curLeft, newTop = curTop;
            if (newBoundsResult && newBoundsResult[0] && newBoundsResult[0].bounds) {
                var nb = newBoundsResult[0].bounds;
                newLeft = (nb.left && nb.left._value !== undefined) ? nb.left._value : (nb.left || 0);
                newTop = (nb.top && nb.top._value !== undefined) ? nb.top._value : (nb.top || 0);
            }
            var moveX = targetSelection.left - newLeft;
            var moveY = targetSelection.top - newTop;
            console.log("[贴图] 移动偏移: dx=" + moveX + " dy=" + moveY);
            if (Math.abs(moveX) > 0.5 || Math.abs(moveY) > 0.5) {
                await action([{
                    _obj: "move",
                    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                    to: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: Math.round(moveX) }, vertical: { _unit: "pixelsUnit", _value: Math.round(moveY) } }
                }], 'move');
            }
            await checkpointReturn(returnOptions, 'move', targetDoc);
        }

        // === Step 4+5: 按图层类型分流（关键修复：智能对象不再栅格化，保住内部原生 2048）===
        if (layerType === 'smartObject') {
            // 【智能对象输出】placeEvent 进来本就是装着完整原生 2048 的智能对象。
            // 绝不栅格化、绝不 newPlacedLayer —— 否则会把已被缩放显示到选区尺寸的内容烤死成低分辨率像素。
            // 抗截断反转直接作用在智能对象上：flip 是非破坏变换；hueSaturation 会自动变成智能滤镜，
            // 都不会破坏内部的 2048 像素（代价：智能对象“内部源”仍是反色，仅显示被滤镜纠正，正常使用无感）。
            if (antiMode > 0) {
                if (antiMode === 2) {
                    // 垂直翻转图层（非破坏变换，智能对象内部数据不丢）
                    await action([{
                        _obj: "flip",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        axis: { _enum: "orientation", _value: "vertical" }
                    }], 'flip');
                }
                // 色相反转180度（作用在智能对象上 → 智能滤镜，非破坏）
                await action([{
                    _obj: "hueSaturation",
                    adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 180, saturation: 0, lightness: 0 }],
                    colorize: false
                }], 'hue-saturation');
            }
            // —— 结束：图层保持为原生 2048 智能对象，显示缩放到选区尺寸 ——
        } else {
            // 【栅格化输出】维持老链路：先栅格化成像素，再在像素上做抗截断反转。
            await action([{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], 'rasterize');
            await checkpointReturn(returnOptions, 'rasterize', targetDoc);
            if (antiMode > 0) {
                if (antiMode === 2) {
                    // 翻转图层（非文档）：选中图层后执行垂直翻转
                    await action([{
                        _obj: "flip",
                        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                        axis: { _enum: "orientation", _value: "vertical" }
                    }], 'flip');
                }
                // 色相反转180度
                await action([{
                    _obj: "hueSaturation",
                    adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 180, saturation: 0, lightness: 0 }],
                    colorize: false
                }], 'hue-saturation');
            }
        }

        try {
            var finishedLayerId = app.activeDocument.activeLayers[0].id;
            if (strategy !== 'legacy' && Number(finishedLayerId) !== Number(placedLayerId)) throw new Error('ACTIVE_LAYER_CHANGED');
            placedLayerId = finishedLayerId;
        } catch (ePlaced) {
            throw returnStateError('RETURN_LAYER_RECEIPT_FAILED', 'Photoshop 没有返回新建回图层编号', { stage: 'finish', cause: String(ePlaced && ePlaced.message || ePlaced) });
        }
        completed = true;
        } catch (eOperation) {
            operationError = eOperation;
            if (outcome.placementAttempted && !outcome.placementOccurred && strategy !== 'legacy' && visibilitySnapshot) {
                // 部分宿主可能先创建图层、再返回失败/取消。失败回执本身不能证明
                // 没有置入；记录新出现的 ID，仅用于诊断，绝不自行删除或盲目重试。
                try {
                    var originalIds = new Set(visibilitySnapshot.map(function(row) { return row.id; }));
                    var appeared = captureReturnVisibility(targetDoc).filter(function(row) { return !originalIds.has(row.id) && row.id !== Number(anchorId); }).map(function(row) { return row.id; });
                    outcome.possibleLayerIds = appeared;
                    if (appeared.length) { outcome.placementOccurred = true; outcome.placementUncertain = true; }
                } catch (_) { outcome.placementUncertain = true; }
            }
            outcome.errors.push({ code: eOperation && eOperation.code || 'RETURN_OPERATION_FAILED', stage: eOperation && eOperation.returnStage || outcome.stage, message: returnErrorText(eOperation) });
            if (eOperation && typeof eOperation === 'object') { try { eOperation.message = returnErrorText(eOperation); } catch (_) {} }
            throw eOperation;
        } finally {
            // anchor 只允许删除本次调用创建的 ID；绝不按名字或 ordinal 删除用户图层。
            var cleanupError = null;
            if (anchorId != null) {
                try {
                    await checkedReturnBatch([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: Number(anchorId) }, { _ref: 'document', _id: Number(targetDocId) }] }], 'anchor-delete');
                    if (captureReturnVisibility(targetDoc).some(function(row) { return row.id === Number(anchorId); })) {
                        cleanupError = returnStateError('RETURN_ANCHOR_DELETE_FAILED', '回图锚点图层删除后仍存在', { stage: 'anchor-delete', anchorId: Number(anchorId) });
                    } else outcome.anchorRemoved = true;
                } catch (eAnchor) {
                    cleanupError = returnStateError('RETURN_ANCHOR_DELETE_FAILED', '回图锚点图层删除失败', { stage: 'anchor-delete', anchorId: Number(anchorId), cause: String(eAnchor && eAnchor.message || eAnchor) });
                }
            }
            if (strategy !== 'legacy' && placedLayerId != null) {
                try {
                    // 删除一个未选中的 anchor 通常不改变当前结果层；无需重复 select。
                    // 必須恢复选中时先做，再做最后的 visibility restore/verify，防止
                    // 特定 Photoshop 版本在 select 时再次修改独显状态。
                    var selected = app.activeDocument && app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
                    if (!selected || Number(selected.id) !== Number(placedLayerId) || Number(app.activeDocument.id) !== Number(targetDocId)) {
                        await checkedReturnBatch([{ _obj: 'select', _target: [{ _ref: 'layer', _id: Number(placedLayerId) }, { _ref: 'document', _id: Number(targetDocId) }], makeVisible: false }], 'restore-selection');
                    }
                }
                catch (eSelection) { if (!cleanupError) cleanupError = eSelection; }
            }
            if (strategy !== 'legacy' && visibilitySnapshot) {
                try { outcome.visibility = await restoreReturnVisibility(targetDocId, visibilitySnapshot); outcome.visibilityRestored = true; }
                catch (eRestore) { cleanupError = eRestore && eRestore.code ? eRestore : returnStateError('RETURN_VISIBILITY_RESTORE_FAILED', '恢复 Photoshop 原有图层可见状态失败', { stage: 'visibility-restore', cause: String(eRestore && eRestore.message || eRestore) }); }
            }
            if (cleanupError) {
                outcome.errors.push({ code: cleanupError.code, stage: cleanupError.returnStage || 'cleanup', message: cleanupError.message });
                cleanupError.returnReceipt = outcome;
                if (operationError) {
                    // 保留原始 Photoshop 错误（特别是 -128 取消），清理失败仅附加，
                    // 不能让 finally 把真正失败原因和已置入状态覆盖掉。
                    operationError.returnReceipt = outcome;
                    operationError.cleanupError = { code: cleanupError.code, message: cleanupError.message };
                    throw operationError;
                }
                throw cleanupError;
            }
            if (operationError) operationError.returnReceipt = outcome;
        }
        if (completed) {
            outcome.stage = 'finish';
            try { await checkpointReturn(returnOptions, 'finish', targetDoc); }
            catch (eFinish) { outcome.errors.push({ code: eFinish.code, stage: 'finish', message: eFinish.message }); eFinish.returnReceipt = outcome; throw eFinish; }
        }
        return placedLayerId;
}

// ============================================================
//  急速回图(v6.5.8): 批量单权限贴回 — 一次 executeAsModal + 历史合并,
//  把 N 张的 置入+定位+抗截断 全做完。实测比逐张快 3~4 倍(测试磁贴方式D)。
//  受设置开关 output.fastReturn 控制, 关着时各调用方走老的逐张 placeImageToSpecificDoc。
//
//  items: [{ base64, selection, antiMode, layerType }]  (selection 等可各不相同)
//  返回: [layerId | null]  (与 items 一一对应; 单张失败为 null, 不砸整批)
//  onEach(i, layerId|null): 每张完成的回调(进度上报用)
// ============================================================
async function placeImagesBatch(targetDocId, items, onEach, returnOptions) {
    if (!items || !items.length) return [];
    var files = [];
    var layerIds = [];
    try {
        // 温备: 全部临时文件先写好(不占修改权时间)
        for (var i = 0; i < items.length; i++) {
            files.push(await _writePlaceTempFile(items[i].base64));
        }
        await core.executeAsModal(async function(executionContext) {
            // 历史合并: 整批一步(撤销一次撤整批; PS 内部开销更小)
            var suspensionID = null;
            try {
                try {
                    suspensionID = await executionContext.hostControl.suspendHistory({
                        documentID: targetDocId,
                        name: 'AI 回图 ' + items.length + ' 张'
                    });
                } catch(_h) { /* 挂起失败不影响贴回, 只是历史不合并 */ }

                for (var k = 0; k < items.length; k++) {
                    var lid = null;
                    var itemOptions = returnOptions;
                    var itemReceipt = null;
                    if (returnOptions && typeof returnOptions === 'object') {
                        itemReceipt = {};
                        itemOptions = Object.assign({}, returnOptions, { receipt: itemReceipt });
                    }
                    try {
                        lid = await _placeCoreInModal(files[k], targetDocId, items[k].selection, items[k].antiMode || 0, items[k].layerType || 'smartObject', itemOptions);
                    } catch (ePlace) {
                        // 单张失败跳过继续 — 不能砸掉整批(后面的图和已贴的图都要保住)
                        logToPanel('[急速回图] 第 ' + (k + 1) + ' 张失败(跳过): ' + ((ePlace && ePlace.message) || ePlace), 'warn');
                        if (itemReceipt) {
                            itemReceipt.error = { code: ePlace && ePlace.code || 'RETURN_OPERATION_FAILED', message: returnErrorText(ePlace) };
                            itemReceipt.ok = false;
                        }
                    }
                    if (itemReceipt) {
                        if (itemReceipt.ok !== false) itemReceipt.ok = lid != null;
                        itemReceipt.index = k;
                        if (Array.isArray(returnOptions.receipts)) returnOptions.receipts.push(itemReceipt);
                    }
                    layerIds.push(lid);
                    if (onEach) { try { onEach(k, lid); } catch(_) {} }
                }
            } finally {
                // suspendHistory 成功后，无论循环、回调或 Photoshop 抛什么错都必须恢复。
                if (suspensionID != null) {
                    try { await executionContext.hostControl.resumeHistory(suspensionID); } catch(_r) {}
                }
            }
        }, { commandName: '急速回图·批量贴回' });
        return layerIds;
    } finally {
        // 写文件中途失败、modal 失败和恢复历史失败都不能留下临时 PNG。
        for (var c = 0; c < files.length; c++) { try { await files[c].delete(); } catch(_) {} }
    }
}

// ============================================================
//  盖印 + 蒙版 (2026-09-14 晚, 用户定的新贴回方式)
//
//  用户原话: 「能否让抠像功能直接盖印当前画面然后生成一个蒙版? 而不是传图,
//            这样方便二次微调」
//
//  比老的"贴一张透明图层"好在三处:
//    ① 引擎只回 alpha 一个通道(RGB 全黑), RGB 根本不用出 PS
//    ② 蒙版直接盖在盖印层上, 没有"贴到哪、多大"的问题(坑55 那套 bbox 补丁用不着)
//    ③ 结果是普通图层 + 图层蒙版, 用户拿画笔在蒙版上就能二次微调(PS 原生工作流)
//
//  ⚠⚠ 为什么不用 imaging.putSelection:
//    那个 API 【没在本项目验证过】—— 它要多大的 imageData、能不能只盖选区那块,
//    docs/47 4.0 里就标着"我没在 PS 里试过"。这里改走
//    【已经验证过的置入内核 _placeCoreInModal】: 把 alpha 当一张
//    "RGB 全黑 + alpha=蒙版" 的 PNG 置入成临时像素层 —— 定位/缩放那套坑
//    (docs/46 那次"回图比例错误")早就填完了 —— 再"从图层透明度载入选区"
//    (就是 Ctrl+点图层缩览图, PS 最经典的操作), 最后删掉临时层。
//    半透明的发丝会原样变成半透明选区, 不会被切成硬边。
//
//  ⚠ 顺序绝不能换: 必须【先盖印, 再置入临时层】。
//    反过来的话临时 alpha 层会被一起盖印进去(它也是可见图层)。
// ============================================================

// 盖印可见图层(= Ctrl+Alt+Shift+E)。⚠ 必须已在 executeAsModal 内调用。
// 返回新盖印层的 layerId。
async function _stampVisibleInModal(layerName) {
    // ⚠⚠ 2026-10-15 修（工具箱复测实测，严重）：文档里只有【一个可见图层】时（打开一张 JPG 就只有「背景」），
    //   Photoshop 的"盖印可见图层"什么都不做、也不报错。原来这里接着把"当前选中层"当成盖印出来的新层 ——
    //   那其实是【用户的原图层】：被改名成「抠像」、被挂上蒙版（抠完整张图只剩选区里那一块）；
    //   人体解析更糟：原图层被转成智能对象再复制成一堆。
    //   ⇒ 先记下原有图层 id；盖印后当前层如果不是新的 → 改为复制那唯一的可见层；
    //     还拿不到新层就报错停下，【绝不】去碰原图层。
    var doc = app.activeDocument;
    var known = {}, visibleLeaves = [];
    (function walk(layers, parentVisible) {
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (!layer) continue;
            var lid = Number(layer.id);
            known[lid] = true;
            var vis = parentVisible && layer.visible !== false;
            var kind = layer.kind;
            var isGroup = (constants.LayerKind && kind === constants.LayerKind.GROUP) || String(kind || '').toLowerCase() === 'group';
            if (isGroup) { var kids = null; try { kids = layer.layers; } catch (_) {} walk(kids, vis); }
            else if (vis) visibleLeaves.push(lid);
        }
    })(doc && doc.layers, true);
    var noNewLayer = function () {
        var e = new Error("盖印没有生成新图层，已停止（原图层没有被改动）");
        e.code = "STAMP_NO_NEW_LAYER";
        return e;
    };
    // ⚠ 先跳到最顶层: mergeVisible+duplicate 是"盖印到【当前层】之上"。
    //   不先跳顶层的话, 新层会夹在图层堆中间, 用户在面板里找不到它。
    await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _enum: "ordinal", _value: "front" }], makeVisible: false }], {});
    await app.batchPlay([{ _obj: "mergeVisible", duplicate: true }], {});
    var active = app.activeDocument.activeLayers[0];
    var id = active ? Number(active.id) : 0;
    if (!id || known[id]) {
        // 只有一个可见层：复制它，效果等于盖印
        if (visibleLeaves.length !== 1) throw noNewLayer();
        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: visibleLeaves[0] }], makeVisible: false }], {});
        await app.batchPlay([{ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
        active = app.activeDocument.activeLayers[0];
        id = active ? Number(active.id) : 0;
        if (!id || known[id]) throw noNewLayer();
        await app.batchPlay([{ _obj: "move", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _ref: "layer", _enum: "ordinal", _value: "front" } }], {});
    }
    if (layerName) {
        try {
            await app.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "layer", _id: id }],
                to: { _obj: "layer", name: String(layerName) }
            }], {});
        } catch (_eName) { /* 改名失败不影响主流程 */ }
    }
    return id;
}

// 把一张 alpha PNG 变成当前文档的选区。⚠ 必须已在 executeAsModal 内调用。
//   rawFile   : 已写好的临时 PNG(RGB 全黑 + alpha = 蒙版)
//   selection : 这张 alpha 对应文档上的哪一块(抓选区时那个矩形)
// 做完选区就挂在文档上了, 临时层已经删掉。
async function _alphaToSelectionInModal(rawFile, docId, selection) {
    var tempId = await _placeCoreInModal(rawFile, docId, selection, 0, 'pixel');
    // ⚠ 显式再选一次: placeEvent 之后本来就选中它, 但前面若干步(改名/删层)会打乱选中态
    await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: tempId }], makeVisible: false }], {});
    // 从图层透明度载入选区 —— 就是 Ctrl+点图层缩览图
    await app.batchPlay([{
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" }
    }], {});
    // ⚠ 选区是【文档级】的, 删掉图层不会把选区带走 —— 这一步之后选区还在
    await app.batchPlay([{ _obj: "delete", _target: [{ _ref: "layer", _id: tempId }] }], {});
    return tempId;
}

// 取消选区
async function _deselectInModal() {
    try {
        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }], {});
    } catch (_eDes) {}
}

// 读 PNG 文件头里的宽高（只解前 32 个 base64 字符 = 24 字节，不解整张图）；不是 PNG / 读不出就返回 null（调用方不拦）
function _pngSize(base64Str) {
    try {
        var head = new Uint8Array(base64ToArrayBuffer(String(base64Str || "").replace(/^data:[^,]*,/, "").slice(0, 32)));
        if (head.length < 24 || head[0] !== 137 || head[1] !== 80 || head[2] !== 78 || head[3] !== 71) return null;
        var w = ((head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19]) >>> 0;
        var h = ((head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23]) >>> 0;
        return (w > 0 && h > 0) ? { width: w, height: h } : null;
    } catch (_e) { return null; }
}

// ── 抠像 / SAM2 用: 盖印一层 + 挂一个蒙版 ──────────────────
//   opts: { docId, alphaBase64, selection, layerName }
//   返回: { layerId, layerName }
async function stampAndApplyMask(opts) {
    opts = opts || {};
    var docId = Number(opts.docId);
    var sel = getSelectionRectSafe(opts.selection);
    var layerName = String(opts.layerName || "抠像");
    if (!opts.alphaBase64) {
        var e0 = new Error("没有蒙版数据(alphaBase64 是空的)");
        e0.code = "MASK_NO_ALPHA";
        throw e0;
    }
            var targetDoc = findDocumentById(docId);
    if (!targetDoc) {
        var e1 = new Error("来源文档已经关掉了, 没法盖印");
        e1.code = "SOURCE_DOCUMENT_CLOSED";
        throw e1;
    }
    // ⚠ 没给选区就按整个文档算 —— 全画布抓图那条路(allowFullCanvas)会走到这里
    if (!sel) sel = { left: 0, top: 0, right: targetDoc.width, bottom: targetDoc.height, width: targetDoc.width, height: targetDoc.height };
    // ⭐ 2026-10-20（docs/256 F3b，学员报「抠像蒙版很准，但放大到全图，人只占中间一块、蒙版顶天立地」）：贴之前对一下长宽比 ——
    //   蒙版是从哪块抓图算出来的就该贴回哪块；比例差太多 = 选区丢了 / 拿错了（比如借了整张画布的那次抓图），
    //   原来照贴不误 ⇒ 被拉伸到整张图。现在宁可不贴、如实报出来。
    //   ⚠ 超大选区抓图时会等比缩小（5937×7345 → 4021×4974，比例只差万分之一），不受影响。读不出 PNG 头就不拦。
    var alphaSize = _pngSize(opts.alphaBase64);
    var selW = Number(sel.width) || (Number(sel.right) - Number(sel.left)), selH = Number(sel.height) || (Number(sel.bottom) - Number(sel.top));
    if (alphaSize && selW > 0 && selH > 0) {
        var ratioAlpha = alphaSize.width / alphaSize.height, ratioSel = selW / selH;
        if (Math.abs(ratioAlpha - ratioSel) / ratioSel > 0.03) {
            var e2 = new Error("蒙版跟要贴的位置对不上（蒙版 " + alphaSize.width + "×" + alphaSize.height + "，位置 " + Math.round(selW) + "×" + Math.round(selH)
                + "），可能是选区丢了 —— 没有贴，免得拉伸变形。请重新框选后再抠一次");
            e2.code = "MASK_RECT_MISMATCH";
            throw e2;
        }
    }

    var rawFile = await _writePlaceTempFile(opts.alphaBase64);
    var stampedId = null;
    try {
        await core.executeAsModal(async function (executionContext) {
            var suspensionID = null;
            try {
                try {
                    suspensionID = await executionContext.hostControl.suspendHistory({ documentID: docId, name: layerName + " · 盖印+蒙版" });
                } catch (_h) { /* 历史不合并而已, 不影响功能 */ }

                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
                // ① 盖印当前画面
                stampedId = await _stampVisibleInModal(layerName);
                // ② alpha → 选区(内部会置入临时层再删掉)
                await _alphaToSelectionInModal(rawFile, docId, sel);
                // ③ 回到盖印层, 从选区建蒙版(选区外自动是黑 = 被挡住)
                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: stampedId }], makeVisible: false }], {});
                await app.batchPlay([{
                    _obj: "make",
                    new: { _class: "channel" },
                    at: { _ref: "channel", _enum: "channel", _value: "mask" },
                    using: { _enum: "userMaskEnabled", _value: "revealSelection" }
                }], {});
                // ④ 加完蒙版当前 target 是蒙版通道, 把选中还给图层本身
                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: stampedId }], makeVisible: false }], {});
                await _deselectInModal();
            } finally {
                if (suspensionID != null) {
                    try { await executionContext.hostControl.resumeHistory(suspensionID); } catch (_r) {}
                }
            }
        }, { commandName: layerName + " · 盖印+蒙版" });
        logToPanel("[盖印蒙版] 完成 · 图层「" + layerName + "」id=" + stampedId, "info");
        return { layerId: stampedId, layerName: layerName };
    } finally {
        try { await rawFile.delete(); } catch (_) {}
    }
}

// ── 任务卡「分割」/ 眼神调整：按像素精确写（2026-10-26 改）────────────────────
//   ⚠⚠ 10-26 真机实测（docs/292 第八节）：原来的做法是「把蒙版当透明 PNG 置入 → 从透明度载入选区」——
//     置入内核按图里【不透明那部分】的边界对位置和缩放，物体外面全透明的蒙版会被拉伸到整块（用户报「蒙版是歪的，被全图拉伸了」）；
//     四角补不透明像素也救不回来（还是被重采样了一点）。另外置入时文档和图片奇偶不一致会偏 1 像素。
//   ⇒ 改走 imaging 接口直接写像素，位置用 targetBounds 精确指定，不经过置入 / 缩放 / 移动。
//     （imaging.putPixels 本项目 AI 修图痕迹检测在用，已验证；putLayerMask 跟它同一族。）

// 游程编码解码：[值 1 字节][次数 LEB128]…，界面那边 diff-mask-worker.js 编的（蒙版大段都是 0 / 255，压完很小）
function _rleDecode(bytes, total) {
    var out = new Uint8Array(total), o = 0, i = 0;
    while (i < bytes.length && o < total) {
        var v = bytes[i++], n = 0, shift = 0, b;
        do { b = bytes[i++]; n += (b & 127) * Math.pow(2, shift); shift += 7; } while (b & 128 && i < bytes.length);
        if (o + n > total) n = total - o;
        out.fill(v, o, o + n); o += n;
    }
    if (o !== total) { var e = new Error("蒙版数据长度不对（" + o + " / " + total + "）"); e.code = "MASK_DATA_INVALID"; throw e; }
    return out;
}

//   opts: { docId, layerId, maskRle(base64), width, height, left, top }  —— 蒙版在文档坐标里正好盖 [left, top, width, height]
//   ⚠ 图层原来的蒙版（传回时的边缘羽化、上一次分割）先删掉（不应用）再建：用户要的是「蒙版 = 调出来的区域」，不是两个叠着
async function applyAlphaMaskToLayer(opts) {
    opts = opts || {};
    var docId = Number(opts.docId), layerId = Number(opts.layerId);
    var w = Math.round(Number(opts.width)), h = Math.round(Number(opts.height));
    var left = Math.round(Number(opts.left)), top = Math.round(Number(opts.top));
    if (!opts.maskRle || !(w > 0) || !(h > 0) || !isFinite(left) || !isFinite(top)) {
        var e0 = new Error("蒙版数据不全（要 maskRle / width / height / left / top）");
        e0.code = "MASK_NO_ALPHA";
        throw e0;
    }
    if (!imaging || typeof imaging.putLayerMask !== "function") {
        var e9 = new Error("这个版本的 Photoshop 没有「写图层蒙版」接口（imaging.putLayerMask），分割蒙版贴不上。请升级 Photoshop");
        e9.code = "MASK_API_UNAVAILABLE";
        throw e9;
    }
    if (!findDocumentById(docId)) {
        var e2 = new Error("来源文档已经关掉了, 没法挂蒙版");
        e2.code = "SOURCE_DOCUMENT_CLOSED";
        throw e2;
    }
    var gray = _rleDecode(new Uint8Array(base64ToArrayBuffer(opts.maskRle)), w * h);
    await core.executeAsModal(async function (executionContext) {
        var suspensionID = null, imageData = null;
        try {
            try {
                suspensionID = await executionContext.hostControl.suspendHistory({ documentID: docId, name: "分割蒙版" });
            } catch (_h) { /* 历史不合并而已 */ }
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});
            try {
                await app.batchPlay([{ _obj: "delete", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] }], {});
            } catch (_noMask) { /* 本来没有蒙版 */ }
            // 先建一个「全显示」的蒙版，再把这块像素写进去（矩形外面图层本来就没内容）
            await _deselectInModal();
            await app.batchPlay([{
                _obj: "make", new: { _class: "channel" },
                at: { _ref: "channel", _enum: "channel", _value: "mask" },
                using: { _enum: "userMaskEnabled", _value: "revealAll" }
            }], {});
            imageData = await imaging.createImageDataFromBuffer(gray, { width: w, height: h, components: 1, chunky: true, colorSpace: "Grayscale" });
            await imaging.putLayerMask({ documentID: docId, layerID: layerId, imageData: imageData, replace: false, targetBounds: { left: left, top: top } });
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});
        } finally {
            if (imageData) { try { imageData.dispose(); } catch (_d) {} }
            if (suspensionID != null) {
                try { await executionContext.hostControl.resumeHistory(suspensionID); } catch (_r) {}
            }
        }
    }, { commandName: "分割蒙版" });
    logToPanel("[分割蒙版] 完成 · 图层 id=" + layerId + " · " + w + "×" + h + " @ " + left + "," + top, "info");
    return { layerId: layerId };
}

// ── 眼神调整：新建一个普通图层，把一块 RGBA 像素按文档坐标精确写进去 ──────────
//   opts: { docId, name, rgba(base64，宽×高×4 原始字节), width, height, left, top }
//   ⚠ 新图层建在当前选中图层上面；透明的地方不盖原图。
async function placePixelsAsNewLayer(opts) {
    opts = opts || {};
    var docId = Number(opts.docId);
    var w = Math.round(Number(opts.width)), h = Math.round(Number(opts.height));
    var left = Math.round(Number(opts.left)), top = Math.round(Number(opts.top));
    var bytes = new Uint8Array(base64ToArrayBuffer(String(opts.rgba || "")));
    if (!(w > 0) || !(h > 0) || bytes.length !== w * h * 4) {
        var e0 = new Error("像素数据不对（" + bytes.length + " 字节，应该是 " + (w * h * 4) + "）");
        e0.code = "PIXELS_INVALID";
        throw e0;
    }
    if (!findDocumentById(docId)) {
        var e1 = new Error("来源文档已经关掉了, 没法传回");
        e1.code = "SOURCE_DOCUMENT_CLOSED";
        throw e1;
    }
    var layerId = null;
    await core.executeAsModal(async function (executionContext) {
        var suspensionID = null, imageData = null;
        try {
            try {
                suspensionID = await executionContext.hostControl.suspendHistory({ documentID: docId, name: String(opts.name || "眼神调整") });
            } catch (_h) {}
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
            var made = await app.batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: String(opts.name || "眼神调整") } }], {});
            layerId = made && made[0] && (made[0].layerID || made[0].layerId);
            if (!layerId) { try { layerId = app.activeDocument.activeLayers[0].id; } catch (_) {} }
            if (!layerId) { var e2 = new Error("Photoshop 没返回新图层编号"); e2.code = "RETURN_LAYER_RECEIPT_FAILED"; throw e2; }
            imageData = await imaging.createImageDataFromBuffer(bytes, { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
            await imaging.putPixels({ documentID: docId, layerID: Number(layerId), imageData: imageData, replace: true, targetBounds: { left: left, top: top } });
            // 设置里「传回图层类型」是智能对象 ⇒ 原地转成智能对象（不挪像素；转完图层编号会变，重新读一次）
            if (opts.layerType === "smartObject") {
                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: Number(layerId) }], makeVisible: false }], {});
                await app.batchPlay([{ _obj: "newPlacedLayer" }], {});
                try { layerId = app.activeDocument.activeLayers[0].id; } catch (_) {}
            }
        } finally {
            if (imageData) { try { imageData.dispose(); } catch (_d) {} }
            if (suspensionID != null) {
                try { await executionContext.hostControl.resumeHistory(suspensionID); } catch (_r) {}
            }
        }
    }, { commandName: String(opts.name || "眼神调整") });
    logToPanel("[按像素传回] 完成 · 图层「" + (opts.name || "眼神调整") + "」id=" + layerId + " · " + w + "×" + h + " @ " + left + "," + top, "info");
    return { layerId: Number(layerId) };
}

// ── 语义分割用: 盖印一层 → 转智能对象 → 复制 N 份 → 每份挂一个部位蒙版 → 装进一个组 ──
//
//   用户原话:「新建一个组 组里是我的多份原图, 原图会有蒙版, 蒙版就是推理出的部位和范围
//             图层的名字是部位名字」
//
//   ⚠⚠ 为什么中间要【转智能对象】:
//     盖印出来是普通像素层, 复制 10 份 = 10 份真像素。
//     一张 5000×4000 的图会直接把文件撑到几个 G, PS 也会卡。
//     智能对象图层【普通复制(duplicate)出来的副本共享同一份源数据】,
//     所以 10 份只占 1 份的像素。用起来和普通图层一样, 蒙版照样能拿画笔改。
//     (⚠ 只有"通过拷贝新建智能对象"才会断开共享 —— 这里【不能】用那个)
//
//   opts: { docId, selection, groupName, parts: [{ name, alphaBase64 }] }
//   返回: { groupName, layerIds: [...], names: [...] }
async function stampAndApplyMaskGroup(opts) {
    opts = opts || {};
    var docId = Number(opts.docId);
    var parts = Array.isArray(opts.parts) ? opts.parts.filter(function (p) { return p && p.alphaBase64; }) : [];
    var groupName = String(opts.groupName || "人体解析");
    var sel = getSelectionRectSafe(opts.selection);
    if (!parts.length) {
        var e0 = new Error("一个部位都没给, 没东西可以做成蒙版");
        e0.code = "MASK_NO_PARTS";
        throw e0;
    }
            var targetDoc = findDocumentById(docId);
    if (!targetDoc) {
        var e1 = new Error("来源文档已经关掉了, 没法盖印");
        e1.code = "SOURCE_DOCUMENT_CLOSED";
        throw e1;
    }
    if (!sel) sel = { left: 0, top: 0, right: targetDoc.width, bottom: targetDoc.height, width: targetDoc.width, height: targetDoc.height };

    // 临时文件全部先写好(不占修改权时间, 和急速回图一个路数)
    var files = [];
    var madeIds = [];
    var madeNames = [];
    try {
        for (var i = 0; i < parts.length; i++) {
            files.push(await _writePlaceTempFile(parts[i].alphaBase64));
        }
        await core.executeAsModal(async function (executionContext) {
            var suspensionID = null;
            try {
                try {
                    suspensionID = await executionContext.hostControl.suspendHistory({ documentID: docId, name: groupName + " · " + parts.length + " 个部位" });
                } catch (_h) {}

                await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {});
                // ① 盖印当前画面
                var stampedId = await _stampVisibleInModal(groupName + " 母本");
                // ② 转成智能对象(母本)。之后每个部位都从它复制, 共享同一份像素。
                await app.batchPlay([{ _obj: "newPlacedLayer" }], {});
                var masterId = app.activeDocument.activeLayers[0].id;

                // ③ 一个部位一份副本
                for (var k = 0; k < parts.length; k++) {
                    var pname = String(parts[k].name || ("部位" + (k + 1)));
                    try {
                        // a. 这个部位的 alpha → 选区
                        await _alphaToSelectionInModal(files[k], docId, sel);
                        // b. 从母本复制一份(共享源)
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: masterId }], makeVisible: false }], {});
                        await app.batchPlay([{ _obj: "duplicate", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
                        var copyId = app.activeDocument.activeLayers[0].id;
                        // c. 给副本挂这个部位的蒙版
                        await app.batchPlay([{
                            _obj: "make",
                            new: { _class: "channel" },
                            at: { _ref: "channel", _enum: "channel", _value: "mask" },
                            using: { _enum: "userMaskEnabled", _value: "revealSelection" }
                        }], {});
                        // d. 选中还给图层本身, 再改名成部位名
                        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: copyId }], makeVisible: false }], {});
                        await app.batchPlay([{
                            _obj: "set",
                            _target: [{ _ref: "layer", _id: copyId }],
                            to: { _obj: "layer", name: pname }
                        }], {});
                        await _deselectInModal();
                        madeIds.push(copyId);
                        madeNames.push(pname);
                    } catch (ePart) {
                        // ⚠ 单个部位失败不能砸掉整批 —— 其它部位和已经做好的都要保住
                        logToPanel("[分割蒙版] 部位「" + pname + "」失败(跳过): " + ((ePart && ePart.message) || ePart), "warn");
                        try { await _deselectInModal(); } catch (_) {}
                    }
                }

                // ④ 删掉母本。⚠ 智能对象的源数据由副本们共同持有, 删母本不会让副本变空。
                try {
                    await app.batchPlay([{ _obj: "delete", _target: [{ _ref: "layer", _id: masterId }] }], {});
                } catch (eDelMaster) {
                    logToPanel("[分割蒙版] 母本没删掉(不影响结果): " + ((eDelMaster && eDelMaster.message) || eDelMaster), "warn");
                }

                // ⑤ 把 N 个副本装进一个组
                if (madeIds.length) {
                    var selectTargets = madeIds.map(function (id) { return { _ref: "layer", _id: id }; });
                    await app.batchPlay([{ _obj: "select", _target: selectTargets, selectionModifier: { _enum: "selectionModifierType", _value: "replaceSelection" }, makeVisible: false }], {});
                    await app.batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: groupName }], {});
                    // ⚠ 双保险改名: 部分 PS 版本(27.x)无视 make 顶层的 name, 组名会落成默认"组 1"
                    try {
                        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", name: groupName } }], {});
                    } catch (_eGName) {}
                    // 展开组, 让用户一眼看见里面按部位分好的图层
                    try {
                        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", layerSectionExpanded: true } }], {});
                    } catch (_eExp) {}
                }
                if (stampedId) { /* stampedId 已被 newPlacedLayer 吃掉, 这里只是留个名字 */ }
            } finally {
                if (suspensionID != null) {
                    try { await executionContext.hostControl.resumeHistory(suspensionID); } catch (_r) {}
                }
            }
        }, { commandName: groupName + " · 盖印+分部位蒙版" });

        if (!madeIds.length) {
            var e2 = new Error("每个部位都没做成 —— 一个蒙版都没生成");
            e2.code = "MASK_ALL_PARTS_FAILED";
            throw e2;
        }
        logToPanel("[分割蒙版] 完成 · 组「" + groupName + "」共 " + madeIds.length + " 个部位: " + madeNames.join("、"), "info");
        return { groupName: groupName, layerIds: madeIds, names: madeNames };
    } finally {
        for (var c = 0; c < files.length; c++) { try { await files[c].delete(); } catch (_) {} }
    }
}

// 预设组名编号器: 同一预设本次会话内递增(预设名 1 / 预设名 2 …)
var _presetGroupSeq = {};

async function createGroupAndMask(layerIds, groupNamePrefix, maskOptions) {
    // 用预设生成的组: 组名 = 预设名 + 编号(始终开启, 无开关); 没用预设走原来的 "xxx 生成组"
    var _groupName;
    var _pn = maskOptions && maskOptions.presetName;
    if (_pn && String(_pn).trim()) {
        _pn = String(_pn).trim();
        _presetGroupSeq[_pn] = (_presetGroupSeq[_pn] || 0) + 1;
        _groupName = _pn + ' ' + _presetGroupSeq[_pn];
    } else {
        _groupName = groupNamePrefix + " 生成组";
    }
    var selectTargets = layerIds.map(function(id) { return { _ref: "layer", _id: id }; });
    await app.batchPlay([{ _obj: "select", _target: selectTargets, selectionModifier: { _enum: "selectionModifierType", _value: "replaceSelection" }, makeVisible: false }], {});
    await app.batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: _groupName }], {});
    // 双保险改名(2026-07-11): 部分 PS 版本(27.x)无视 make 顶层的 name 参数, 组名落成默认"组 1" —
    // 建组后当前选中即新组, 再显式 set 一次名字(该写法已在曲线命名处验证有效)
    try {
        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", name: _groupName } }], {});
    } catch (eSetName) {}
    await app.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", color: { _enum: "color", _value: "yellowColor" } } }], {});
    // 强制将组移到图层栈最顶层（防止在隐藏图层/嵌套组内部时不在顶层）
    // 注意：这里的 move + to layer front 是图层栈移动，不是画布空间移动
    await app.batchPlay([{
        _obj: "move",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: { _ref: "layer", _enum: "ordinal", _value: "front" }
    }], {});

    var useSeamMask = false;
    var seamRect = null;
    var seamBlur = 0;
    if (maskOptions && maskOptions.selection && (maskOptions.direction === 'left' || maskOptions.direction === 'top')) {
        var insetPx = Math.max(0, parseInt(maskOptions.insetPx, 10) || 0);
        seamBlur = Math.max(0, parseInt(maskOptions.blurPx, 10) || 0);
        var sel = maskOptions.selection;
        var ml = sel.left;
        var mt = sel.top;
        var mr = sel.right;
        var mb = sel.bottom;
        if (maskOptions.direction === 'left') ml = Math.min(mr - 1, ml + insetPx);
        if (maskOptions.direction === 'top') mt = Math.min(mb - 1, mt + insetPx);
        if ((mr - ml) >= 1 && (mb - mt) >= 1) {
            seamRect = { left: ml, top: mt, right: mr, bottom: mb };
            useSeamMask = true;
        }
    }

    if (useSeamMask) {
        await app.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
                _obj: "rectangle",
                top: { _unit: "pixelsUnit", _value: seamRect.top },
                left: { _unit: "pixelsUnit", _value: seamRect.left },
                bottom: { _unit: "pixelsUnit", _value: seamRect.bottom },
                right: { _unit: "pixelsUnit", _value: seamRect.right }
            }
        }], {});
        await app.batchPlay([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }], {});
        if (seamBlur > 0) {
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }], makeVisible: false }], {});
            await app.batchPlay([{ _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: seamBlur } }], {});
        }
        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }], {});
    } else {
        // 添加白色蒙版
        await app.batchPlay([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealAll" } }], {});
    }

    // 添加蒙版后，当前target是蒙版通道，需要重新选中组图层本身
    await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], makeVisible: false }], {});
    // 展开组
    await app.batchPlay([{
        _obj: "set",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: { _obj: "layer", layerSectionExpanded: true }
    }], {});
}

function getSelectionRectSafe(selection) {
    if (!selection) return null;
    var left = Number(selection.left);
    var top = Number(selection.top);
    var right = Number(selection.right);
    var bottom = Number(selection.bottom);
    var width = Number(selection.width);
    var height = Number(selection.height);
    if (!isFinite(width) || width <= 0) width = isFinite(right) && isFinite(left) ? (right - left) : 0;
    if (!isFinite(height) || height <= 0) height = isFinite(bottom) && isFinite(top) ? (bottom - top) : 0;
    if (!isFinite(left) || !isFinite(top) || width <= 0 || height <= 0) return null;
    if (!isFinite(right)) right = left + width;
    if (!isFinite(bottom)) bottom = top + height;
    return {
        left: Math.round(left),
        top: Math.round(top),
        right: Math.round(right),
        bottom: Math.round(bottom),
        width: Math.round(width),
        height: Math.round(height)
    };
}

// ============================================================
//  4K偏色自动矫正: banana(Gemini) 模型 4K 出图偏洋红 —
//  编组完成后在组的正上方新建曲线调整层(RGB 128→122 / 绿 120→124),
//  并向下剪贴嵌入到组(只影响这一组, 不碰用户其他图层)。
//  调用约定: 必须在 createGroupAndMask 之后立刻调(此时当前选中 = 生成组);
//  结束时把选中还给组, 教学模式等后续步骤不受影响。
// ============================================================
// ⚠ 本函数不自带 executeAsModal — 跟 createGroupAndMask 同约定, 调用方必须已在 modal 内
async function applyMagentaFixCurveToGroup(groupLabel) {
        // 记住组的 layerID, 结尾还原选中
        var groupId = null;
        try {
            var gRes = await app.batchPlay([{ _obj: "get", _target: [{ _property: "layerID" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
            if (gRes && gRes[0] && gRes[0].layerID) groupId = gRes[0].layerID;
        } catch (eGid) {}
        // 1. 新建曲线调整图层(会插在当前选中(组)的正上方)
        await app.batchPlay([{
            _obj: "make",
            _target: [{ _ref: "adjustmentLayer" }],
            using: { _obj: "adjustmentLayer", type: { _obj: "curves", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } } }
        }], {});
        // 2. 写曲线点: RGB 复合 128→122, 绿通道 120→124 (端点固定 0/255 防止整体漂移)
        await app.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
            to: {
                _obj: "curves",
                presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
                adjustment: [
                    {
                        _obj: "curvesAdjustment",
                        channel: { _ref: "channel", _enum: "channel", _value: "composite" },
                        curve: [
                            { _obj: "paint", horizontal: 0, vertical: 0 },
                            { _obj: "paint", horizontal: 128, vertical: 122 },
                            { _obj: "paint", horizontal: 255, vertical: 255 }
                        ]
                    },
                    {
                        _obj: "curvesAdjustment",
                        channel: { _ref: "channel", _enum: "channel", _value: "green" },
                        curve: [
                            { _obj: "paint", horizontal: 0, vertical: 0 },
                            { _obj: "paint", horizontal: 120, vertical: 124 },
                            { _obj: "paint", horizontal: 255, vertical: 255 }
                        ]
                    }
                ]
            }
        }], {});
        // 3. 命名 + 向下剪贴嵌入到组
        try {
            await app.batchPlay([{ _obj: "set", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], to: { _obj: "layer", name: "4K偏色矫正" } }], {});
        } catch (eName) {}
        await app.batchPlay([{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
        // 4. 选中还给组(教学模式等后续操作依赖"当前选中=主组")
        if (groupId !== null) {
            try { await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: groupId }], makeVisible: false }], {}); } catch (eSel) {}
        }
    logToPanel("[4K偏色矫正] 已在「" + (groupLabel || '生成组') + "」内嵌入矫正曲线 (RGB 128→122 / 绿 120→124)", "success");
}

async function applyReturnFeatherMaskToLayer(targetDocId, layerId, selection, workflowKey) {
    // 自动扩充+裁切: selection.cropRect 存在 = 这单发送前补过白边,
    // 蒙版基准用原选区(cropRect) → 白边被蒙掉; 且即使该工作流羽化关着也必须建蒙版(硬边, 收缩/模糊为 0)
    var cropMode = !!(selection && selection.cropRect);
    var rfOn = shouldApplyReturnFeather(workflowKey);
    if (!rfOn && !cropMode) return;
    var rect = getSelectionRectSafe(cropMode ? selection.cropRect : selection);
    if (!rect || !layerId) return;

    var shortSide = Math.max(1, Math.min(rect.width, rect.height));
    var shrinkPct = rfOn ? Math.max(0, Math.min(50, Number(state.getReturnFeatherShrinkPercent()) || 0)) : 0;
    var blurPct = rfOn ? Math.max(0, Math.min(50, Number(state.getReturnFeatherBlurPercent()) || 0)) : 0;
    var contractPx = Math.max(0, Math.round(shortSide * shrinkPct / 100));
    var blurPx = Math.max(0, shortSide * blurPct / 100);
    if (cropMode) logToPanel("[扩充裁切] 贴回按原选区加蒙版, 白边已裁 (羽化" + (rfOn ? "叠加" : "未开, 硬边") + ")", "info");

    await core.executeAsModal(async function() {
        if (targetDocId) {
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: targetDocId }] }], {});
        }

        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});
        await app.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
                _obj: "rectangle",
                top: { _unit: "pixelsUnit", _value: rect.top },
                left: { _unit: "pixelsUnit", _value: rect.left },
                bottom: { _unit: "pixelsUnit", _value: rect.bottom },
                right: { _unit: "pixelsUnit", _value: rect.right }
            }
        }], {});

        if (contractPx > 0) {
            try {
                await app.batchPlay([{ _obj: "contract", by: { _unit: "pixelsUnit", _value: contractPx } }], {});
            } catch (e) {}
        }

        await app.batchPlay([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }], {});

        if (blurPx > 0) {
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }], makeVisible: false }], {});
            await app.batchPlay([{ _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: blurPx } }], {});
        }

        await app.batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }], {});
        await app.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});
    }, { commandName: "传回边缘羽化" });
}

function calculatePartitionSelections(width, height) {
    var selections = [];
    if (width > height) {
        var size = height;
        selections.push({ left: 0, top: 0, right: size, bottom: size, width: size, height: size, name: "左上" });
        selections.push({ left: width - size, top: 0, right: width, bottom: size, width: size, height: size, name: "右上" });
    } else if (height > width) {
        var size2 = width;
        selections.push({ left: 0, top: 0, right: size2, bottom: size2, width: size2, height: size2, name: "左上" });
        selections.push({ left: 0, top: height - size2, right: size2, bottom: height, width: size2, height: size2, name: "左下" });
    } else {
        selections.push({ left: 0, top: 0, right: width, bottom: height, width: width, height: height, name: "全图" });
    }
    return selections;
}

// ============================================================
//  抓取参考图（选区截图，不含抗截断处理）
// ============================================================
async function handleCaptureRefImage() {
    try {
        var doc = app.activeDocument;
        if (!doc) { sendToPanel('captureRefResult', { success: false, error: "没有打开的文档" }); return; }
        // 参考图不应用抗截断，临时保存并恢复
        var savedAntiMode = state.getAntiTruncationMode();
        var capture;
        try {
            state.setAntiTruncationMode(0);
            capture = await getSelectionAndImage();
        } finally {
            state.setAntiTruncationMode(savedAntiMode);
        }
        if (!capture) {
            sendToPanel('captureRefResult', { success: false, error: "未检测到选区" });
            return;
        }
        // 抓取成功后取消选区
        await deselectAll();
        sendToPanel('captureRefResult', { success: true, base64: capture.base64, selection: capture.selection, docId: doc.id });
        logToPanel("[参考图] 选区已抓取并取消选区", "success");
    } catch (e) {
        sendToPanel('captureRefResult', { success: false, error: e.message });
    }
}

// ============================================================
//  重新获取图1（主图）选区
// ============================================================
async function handleRecaptureMainImage() {
    try {
        var doc = app.activeDocument;
        if (!doc) { sendToPanel('recaptureMainResult', { success: false, error: "没有打开的文档" }); return; }
        var capture = await getSelectionAndImage();
        if (!capture) { sendToPanel('recaptureMainResult', { success: false, error: "未检测到选区" }); return; }
        await deselectAll();
        sendToPanel('recaptureMainResult', { success: true, base64: capture.base64, selection: capture.selection, docId: doc.id });
    } catch (e) {
        sendToPanel('recaptureMainResult', { success: false, error: e.message });
    }
}

// ============================================================
//  重新获取参考图选区
// ============================================================
async function handleRecaptureRefImage(data) {
    try {
        var doc = app.activeDocument;
        if (!doc) { sendToPanel('recaptureRefResult', { success: false, error: "没有打开的文档" }); return; }
        var savedAntiMode = state.getAntiTruncationMode();
        var capture;
        try {
            state.setAntiTruncationMode(0);
            capture = await getSelectionAndImage();
        } finally {
            state.setAntiTruncationMode(savedAntiMode);
        }
        if (!capture) { sendToPanel('recaptureRefResult', { success: false, error: "未检测到选区" }); return; }
        await deselectAll();
        sendToPanel('recaptureRefResult', { success: true, base64: capture.base64, index: data.index, selection: capture.selection, docId: doc.id });
    } catch (e) {
        sendToPanel('recaptureRefResult', { success: false, error: e.message });
    }
}

// ============================================================
//  恢复选区（点击图1标签时调用）
// ============================================================
async function handleRestoreSelection() {
    try {
        var lastSel = state.getLastSelection();
        var lastDocId = state.getLastSelectionDocId();
        if (!lastSel || !lastDocId) {
            logToPanel("[图1] 没有保存的选区信息，请先生成一次", "error");
            return;
        }
        await core.executeAsModal(async function() {
            // 切到保存选区的文档
            await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: lastDocId }] }], {});
            // 创建矩形选区
            await app.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "channel", _property: "selection" }],
                to: {
                    _obj: "rectangle",
                    top: { _unit: "pixelsUnit", _value: lastSel.top },
                    left: { _unit: "pixelsUnit", _value: lastSel.left },
                    bottom: { _unit: "pixelsUnit", _value: lastSel.bottom },
                    right: { _unit: "pixelsUnit", _value: lastSel.right }
                }
            }], {});
        }, { commandName: "恢复选区" });
        logToPanel("[图1] 已恢复选区 (" + lastSel.width + "x" + lastSel.height + ")", "success");
    } catch (e) {
        logToPanel("[图1] 恢复选区失败: " + e.message, "error");
    }
}

async function handleRestoreSelectionFromHistory(params) {
    try {
        var sel = params && params.selection;
        var docId = params && params.docId;
        if (!sel) { logToPanel("[历史] 该记录没有保存选区信息", "error"); return; }
        await core.executeAsModal(async function() {
            if (docId) {
                try { await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: docId }] }], {}); } catch(e) {}
            }
            await app.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "channel", _property: "selection" }],
                to: {
                    _obj: "rectangle",
                    top: { _unit: "pixelsUnit", _value: sel.top },
                    left: { _unit: "pixelsUnit", _value: sel.left },
                    bottom: { _unit: "pixelsUnit", _value: sel.bottom },
                    right: { _unit: "pixelsUnit", _value: sel.right }
                }
            }], {});
        }, { commandName: "恢复历史选区" });
        logToPanel("[历史] 已恢复选区 (" + sel.width + "×" + sel.height + ")", "success");
    } catch (e) {
        logToPanel("[历史] 恢复选区失败: " + e.message, "error");
    }
}

// ============================================================
//  抓取选区图片给聊天面板用
// ============================================================
async function handleCaptureForChat() {
    try {
        var doc = app.activeDocument;
        if (!doc) { sendToPanel('captureForChatResult', { success: false, error: "没有打开的文档" }); return; }
        // 使用聊天独立的压缩分辨率（从存储读取，默认1024）
        var savedChatMaxRes = state.getHostStorage()['chat_max_resolution'];
        var chatMaxRes = savedChatMaxRes ? parseInt(savedChatMaxRes) : 1024;
        if (isNaN(chatMaxRes) || chatMaxRes < 256) chatMaxRes = 1024;
        var savedMainMaxRes = state.getMaxResolution();
        var savedAntiMode = state.getAntiTruncationMode();
        var capture;
        try {
            state.setMaxResolution(chatMaxRes);
            state.setAntiTruncationMode(0);
            capture = await getSelectionAndImage();
        } finally {
            state.setAntiTruncationMode(savedAntiMode);
            state.setMaxResolution(savedMainMaxRes);
        }
        if (!capture) { sendToPanel('captureForChatResult', { success: false, error: "未检测到选区" }); return; }
        await deselectAll();
        sendToPanel('captureForChatResult', { success: true, base64: capture.base64 });
    } catch (e) {
        sendToPanel('captureForChatResult', { success: false, error: e.message });
    }
}

// ============================================================
//  教学模式: createTeachingMaterials
//  调用约定:必须在 createGroupAndMask 之后立刻调用,此时 active layer 是主组
//  在主组里追加一个"📚 教学资料"子组(默认隐藏),含:
//    - 文字图层(visible:false) 写入闲聊式说明
//    - 参考图层(主图 + 附图,visible:false) 原尺寸
//
//  params: {
//    docId,           // 目标文档 id (用于 modal 内切回文档)
//    prompt, model, provider, size, aspectRatio, batch,
//    selection: {left, top, width, height},
//    docW, docH,
//    antiMode, returnFeather: {enabled, shrink, blur},
//    bodyPresetName, promptPresetName,
//    refImageBase64s: ['mainBase64', 'addRef1', ...]   // 第一项为主选区图;无主图时可为空数组
//    timestamp, taskId, durationSec
//  }
//
//  注意:函数内部进入"主组"上下文做 batchPlay,所以新建的图层和子组都会进主组
// ============================================================
async function createTeachingMaterials(params) {
    if (!params || !params.docId) return;
    var docId = params.docId;

    // 1. 拼装文字内容
    var text = _buildTeachingText(params);

    // 2. 准备附参考图临时文件(在 modal 外执行,避免 modal 内 IO)
    // 第 0 张是"原图选区"(被 AI 修改前的画面),用 placeImageToSpecificDoc 单独处理(贴回选区位置)
    // 后续是用户加的"附参考图",走简单 placeEvent(画布内随意位置)
    var origCaptureBase64 = (params.refImageBase64s && params.refImageBase64s.length) ? params.refImageBase64s[0] : null;
    var addRefBase64s = (params.refImageBase64s || []).slice(1).filter(function(b) { return b && typeof b === 'string'; });
    var refFiles = [];
    if (addRefBase64s.length) {
        try {
            var tmp = await fs.getTemporaryFolder();
            for (var ri = 0; ri < addRefBase64s.length; ri++) {
                try {
                    var ts = Date.now() + '_teach_' + ri + '_' + Math.random().toString(36).substr(2, 4);
                    var rf = await tmp.createFile('teach_' + ts + '.png', { overwrite: true });
                    await rf.write(base64ToArrayBuffer(addRefBase64s[ri]), { format: storage.formats.binary });
                    refFiles.push({
                        file: rf,
                        name: '参考图_' + (ri + 1)
                    });
                } catch (rerr) {
                    logToPanel && logToPanel('[教学] 参考图 ' + ri + ' 缓存失败: ' + rerr.message, 'warn');
                }
            }
        } catch (terr) {
            logToPanel && logToPanel('[教学] 临时目录获取失败: ' + terr.message, 'warn');
        }
    }

    try {
        await core.executeAsModal(async function() {
            var targetDoc = findDocumentById(docId);
            if (!targetDoc) throw new Error('找不到目标文档');
            await app.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }], {});

            // 读文档尺寸(供文案使用)
            if (params.docW == null || params.docH == null) {
                try {
                    params.docW = Math.round(Number(targetDoc.width) || 0);
                    params.docH = Math.round(Number(targetDoc.height) || 0);
                } catch (_) {}
            }

            // 重新拼装文字(此时 docW/docH 才准确)
            text = _buildTeachingText(params);

            // 调用约定:此时 active layer 应是 createGroupAndMask 刚创建的主组
            // 先记下主组的 layerID,后面把教学子组 move 进去
            var mainGroupId = null;
            try {
                var getRes = await app.batchPlay([{
                    _obj: 'get',
                    _target: [{ _property: 'layerID' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                }], { synchronousExecution: true });
                if (getRes && getRes[0]) mainGroupId = getRes[0].layerID;
            } catch (_) {}

            // === a. 创建文字图层 + 参考图,然后编组,最后 move 进主组 ===
            var createdLayerIds = [];

            // a.1 创建文字图层
            await _makeTextLayer(text);
            var textLayerId = app.activeDocument.activeLayers[0].id;
            // 隐藏(用 hide 命令,比 set visible 可靠)
            await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _id: textLayerId }] }], {});
            // 重命名
            await app.batchPlay([{
                _obj: 'set',
                _target: [{ _ref: 'layer', _id: textLayerId }],
                to: { _obj: 'layer', name: '教学说明' }
            }], {});
            createdLayerIds.push(textLayerId);

            // a.2 原图选区:复用 placeImageToSpecificDoc,贴回选区位置(跟生图层重叠,学生隐藏生图就能看到原图)
            //     注意:placeImageToSpecificDoc 自带 executeAsModal,不能在外层 modal 内嵌套调用
            //     解决:把这段 modal 内逻辑用 batchPlay 直接复刻
            //     ★ 但 placeImageToSpecificDoc 太长,简化版:用 placeEvent + 强制贴回选区位置/尺寸
            if (origCaptureBase64 && params.selection && params.selection.width > 0 && params.selection.height > 0) {
                try {
                    var oTs = Date.now() + '_teach_orig_' + Math.random().toString(36).substr(2, 4);
                    // 必须提前在 modal 外创建文件;但我们已经在 modal 内 - 用 fs 在 modal 内不能创建 file
                    // 退路:写到 tempFolder 是 modal 安全的
                    var oTmp = await fs.getTemporaryFolder();
                    var oFile = await oTmp.createFile('teach_orig_' + oTs + '.png', { overwrite: true });
                    await oFile.write(base64ToArrayBuffer(origCaptureBase64), { format: storage.formats.binary });
                    var oToken = await fs.createSessionToken(oFile);
                    await app.batchPlay([{
                        _obj: 'placeEvent',
                        null: { _path: oToken, _kind: 'local' },
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }
                    }], {});
                    var origLayerId = app.activeDocument.activeLayers[0].id;
                    await app.batchPlay([{ _obj: 'rasterizeLayer', _target: [{ _ref: 'layer', _id: origLayerId }] }], {});
                    // 缩放到选区尺寸,移到选区位置(从角落对齐)
                    var sel = params.selection;
                    var bRes = await app.batchPlay([{
                        _obj: 'get',
                        _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: origLayerId }]
                    }], { synchronousExecution: true });
                    var bb = bRes && bRes[0] && bRes[0].bounds;
                    var curL = bb ? (bb.left._value !== undefined ? bb.left._value : bb.left) : 0;
                    var curT = bb ? (bb.top._value !== undefined ? bb.top._value : bb.top) : 0;
                    var curR = bb ? (bb.right._value !== undefined ? bb.right._value : bb.right) : 0;
                    var curB = bb ? (bb.bottom._value !== undefined ? bb.bottom._value : bb.bottom) : 0;
                    var curW = curR - curL, curH = curB - curT;
                    if (curW > 0 && curH > 0) {
                        var sX = (sel.width / curW) * 100;
                        var sY = (sel.height / curH) * 100;
                        if (Math.abs(sX - 100) > 0.1 || Math.abs(sY - 100) > 0.1) {
                            await app.batchPlay([{
                                _obj: 'transform',
                                _target: [{ _ref: 'layer', _id: origLayerId }],
                                freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSCorner0' },
                                width: { _unit: 'percentUnit', _value: sX },
                                height: { _unit: 'percentUnit', _value: sY },
                                interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' }
                            }], {});
                        }
                        // 移动到选区位置
                        var bRes2 = await app.batchPlay([{
                            _obj: 'get',
                            _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: origLayerId }]
                        }], { synchronousExecution: true });
                        var bb2 = bRes2 && bRes2[0] && bRes2[0].bounds;
                        var newL = bb2 ? (bb2.left._value !== undefined ? bb2.left._value : bb2.left) : 0;
                        var newT = bb2 ? (bb2.top._value !== undefined ? bb2.top._value : bb2.top) : 0;
                        var dx = sel.left - newL, dy = sel.top - newT;
                        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                            await app.batchPlay([{
                                _obj: 'move',
                                _target: [{ _ref: 'layer', _id: origLayerId }],
                                to: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: Math.round(dx) }, vertical: { _unit: 'pixelsUnit', _value: Math.round(dy) } }
                            }], {});
                        }
                    }
                    // 隐藏 + 重命名
                    await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _id: origLayerId }] }], {});
                    await app.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _id: origLayerId }],
                        to: { _obj: 'layer', name: '原图选区(AI修改前)' }
                    }], {});
                    createdLayerIds.push(origLayerId);
                } catch (oe) {
                    logToPanel && logToPanel('[教学] 置入原图选区失败: ' + oe.message, 'warn');
                }
            }

            // a.3 附参考图(画布内随意位置,placeEvent 默认行为,不强制 100%)
            for (var ri2 = 0; ri2 < refFiles.length; ri2++) {
                var rfEntry = refFiles[ri2];
                try {
                    var placeToken = await fs.createSessionToken(rfEntry.file);
                    await app.batchPlay([{
                        _obj: 'placeEvent',
                        null: { _path: placeToken, _kind: 'local' },
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }
                    }], {});
                    var refLayerId = app.activeDocument.activeLayers[0].id;
                    await app.batchPlay([{ _obj: 'rasterizeLayer', _target: [{ _ref: 'layer', _id: refLayerId }] }], {});
                    // 隐藏 + 重命名
                    await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _id: refLayerId }] }], {});
                    await app.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _id: refLayerId }],
                        to: { _obj: 'layer', name: rfEntry.name }
                    }], {});
                    createdLayerIds.push(refLayerId);
                } catch (re) {
                    logToPanel && logToPanel('[教学] 置入参考图失败: ' + re.message, 'warn');
                }
            }

            // a.3 把刚创建的图层们编成"📚 教学资料"子组
            if (createdLayerIds.length > 0) {
                var selTargets = createdLayerIds.map(function(id) { return { _ref: 'layer', _id: id }; });
                await app.batchPlay([{
                    _obj: 'select',
                    _target: selTargets,
                    selectionModifier: { _enum: 'selectionModifierType', _value: 'replaceSelection' },
                    makeVisible: false
                }], {});
                await app.batchPlay([{
                    _obj: 'make',
                    _target: [{ _ref: 'layerSection' }],
                    from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
                    name: '教学资料'
                }], {});
                // 拿子组的 layerID
                var teachGroupId = null;
                try {
                    var getRes2 = await app.batchPlay([{
                        _obj: 'get',
                        _target: [{ _property: 'layerID' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                    }], { synchronousExecution: true });
                    if (getRes2 && getRes2[0]) teachGroupId = getRes2[0].layerID;
                } catch (_) {}

                // 子组默认隐藏(用 hide 命令)
                if (teachGroupId != null) {
                    try {
                        await app.batchPlay([{ _obj: 'hide', null: [{ _ref: 'layer', _id: teachGroupId }] }], {});
                    } catch(_) {}
                }

                // 把子组 move 进主组内部
                // 用 photoshop DOM API: targetGroupLayer.moveInside(parentGroupLayer)
                // 比 batchPlay move 更可靠
                if (teachGroupId != null && mainGroupId != null) {
                    try {
                        var docNow = app.activeDocument;
                        var teachLayer = null, mainLayer = null;
                        // 平铺找两个 layer
                        var stack = docNow.layers.slice ? docNow.layers.slice() : [];
                        if (!stack.length) for (var li = 0; li < docNow.layers.length; li++) stack.push(docNow.layers[li]);
                        while (stack.length) {
                            var L = stack.shift();
                            if (!L) continue;
                            if (L.id === teachGroupId) teachLayer = L;
                            if (L.id === mainGroupId) mainLayer = L;
                            if (L.layers && L.layers.length) for (var ki = 0; ki < L.layers.length; ki++) stack.push(L.layers[ki]);
                        }
                        if (teachLayer && mainLayer && typeof teachLayer.moveInside === 'function') {
                            // moveInside 把 teachLayer 移到 mainLayer 内部最顶层
                            await teachLayer.moveInside(mainLayer);
                        } else {
                            // DOM API 不可用,降级到 batchPlay
                            await app.batchPlay([{
                                _obj: 'move',
                                _target: [{ _ref: 'layer', _id: teachGroupId }],
                                to: { _ref: 'layer', _id: mainGroupId },
                                adjustment: false,
                                version: 5
                            }], {});
                        }
                    } catch (mvErr) {
                        logToPanel && logToPanel('[教学] 子组 move 进主组失败: ' + mvErr.message, 'warn');
                    }
                }
            }
        }, { commandName: '教学模式·附加教学资料' });

        logToPanel && logToPanel('[教学] 已附加教学资料到组(文字 + ' + refFiles.length + ' 张参考图)', 'info');
    } catch (e) {
        logToPanel && logToPanel('[教学] 附加教学资料失败: ' + (e.message || e), 'warn');
    }
}

// === 内部:make textLayer with content ===
async function _makeTextLayer(content) {
    // 中文字体在不同系统下名字不一样,用 fontName 而不是 PostScript 名,PS 会做映射
    // 退而求其次用 'AdobeSongStd-Light' 是 Adobe 自带,几乎所有系统可用
    var fontName = 'AdobeSongStd-Light';
    // PS textKey 把 \r 当硬回车;\n 在某些版本被忽略 → 统一替换
    var textForPS = String(content || '').replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    await app.batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'textLayer' }],
        using: {
            _obj: 'textLayer',
            textKey: textForPS,
            antiAlias: { _enum: 'antiAliasType', _value: 'antiAliasCrisp' },
            textClickPoint: {
                _obj: 'paint',
                horizontal: { _unit: 'percentUnit', _value: 5 },
                vertical: { _unit: 'percentUnit', _value: 8 }
            },
            textStyleRange: [{
                _obj: 'textStyleRange',
                from: 0,
                to: textForPS.length,
                textStyle: {
                    _obj: 'textStyle',
                    fontName: fontName,
                    size: { _unit: 'pointsUnit', _value: 14 },
                    color: { _obj: 'RGBColor', red: 255, green: 255, blue: 255 },
                    autoLeading: false,
                    leading: { _unit: 'pointsUnit', _value: 22 }
                }
            }]
        }
    }], {});
}

// === 内部:把 params 拼装成闲聊式说明文字 ===
function _buildTeachingText(p) {
    var lines = [];
    lines.push('修图轮椅·教学说明');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    // 1. 提示词
    lines.push('【这次老师让 AI 干啥】');
    lines.push('"' + (p.prompt || '(本次未填写提示词)') + '"');
    lines.push('');
    var promptLen = (p.prompt || '').length;
    var hasConstraint = /严禁|禁止|preserve|不允许|绝对锁定/.test(p.prompt || '');
    if (hasConstraint) {
        lines.push('—— 这就是老师写给 AI 的提示词。注意里面的');
        lines.push('"严禁/禁止/不允许"——这种约束词非常关键,');
        lines.push('不写的话 AI 容易自由发挥,把不该改的也改了。');
    } else if (promptLen < 30) {
        lines.push('—— 提示词比较简短,适合快速尝试。复杂修图');
        lines.push('建议写得更详细,加上"保留 X / 严禁动 Y"等约束。');
    } else {
        lines.push('—— 这就是老师写给 AI 的提示词。');
        lines.push('提示词越精确,AI 改图越听话。');
    }
    lines.push('');

    // 2. 模型
    lines.push('【用了哪个 AI】');
    lines.push('模型: ' + (p.model || '?') + ' (走 ' + (p.provider ? p.provider.toUpperCase() : '?') + ' 通道)');
    lines.push('画面比例: ' + (p.aspectRatio || '1:1') + ',选区按 ' + (p.size || '2K') + ' 分辨率送过去');
    lines.push('批次: 一次生 ' + (p.batch || 1) + ' 张供选择');
    lines.push('');

    // 3. 范围
    if (p.selection && p.docW && p.docH) {
        lines.push('【画了多大的范围】');
        lines.push('画布: ' + p.docW + ' × ' + p.docH + ' 像素');
        lines.push('选区: ' + (p.selection.width || 0) + ' × ' + (p.selection.height || 0) + ' 像素');
        lines.push('选区位置: 距画布左上角 ' + (p.selection.left || 0) + ' × ' + (p.selection.top || 0));
        lines.push('');
        lines.push('—— 选区不是越大越好。脸部精修就只圈脸,');
        lines.push('别把头发、衣服都框进去——AI 会被无关内容干扰。');
        lines.push('');
    }

    // 4. 保护设置
    lines.push('【保护设置】');
    var antiText = ['关', 'R17 (色相偏移 180°)', 'R17+ (色相偏移 + 垂直翻转)'][p.antiMode || 0];
    lines.push('抗截断: ' + antiText);
    if (p.returnFeather && p.returnFeather.enabled) {
        lines.push('传回羽化: 启用 (内缩 ' + (p.returnFeather.shrink || 2) + '% / 模糊 ' + (p.returnFeather.blur || 3) + '%)');
    } else {
        lines.push('传回羽化: 关闭');
    }
    lines.push('');
    lines.push('—— 抗截断是为了绕过 AI 的安全审查;');
    lines.push('传回羽化是为了让 AI 改的部分边缘自然过渡到原图。');
    lines.push('');

    // 5. 预设
    lines.push('【用了什么预设】');
    var hasPreset = (p.bodyPresetName || p.promptPresetName);
    if (hasPreset) {
        if (p.bodyPresetName) lines.push('身体部位预设: ' + p.bodyPresetName);
        if (p.promptPresetName) lines.push('提示词预设: ' + p.promptPresetName);
        lines.push('');
        lines.push('—— 老师把常用提示词整理成了预设,按"脸"、"手"、');
        lines.push('"光"、"背景"分类。学生练习时可以直接套用。');
    } else {
        lines.push('这次纯手写,无预设。');
        lines.push('');
        lines.push('—— 真实修图大多需要"批量套同一套规则"——');
        lines.push('熟练后建议把常用的写法存成预设方便复用。');
    }
    lines.push('');

    // 6. 时间
    lines.push('【这次生成】');
    var ts = p.timestamp || _formatNow();
    lines.push(ts + (p.durationSec ? ', 耗时 ' + p.durationSec.toFixed(1) + 's' : ''));
    if (p.taskId) lines.push('任务 ID: ' + p.taskId + ' (出问题时报这个号)');
    lines.push('━━━━━━━━━━━━━━━━━━━━');

    return lines.join('\n');
}

function _formatNow() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
         + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}


    // 轻量探测当前 PS 选区矩形 — 不抓像素, 给比例检查用 (回收站/比例预警等场景)
    //   返回 { hasDoc, hasSelection, docWidth, docHeight, docName, docId, selWidth, selHeight }
    //   失败/无选区会返回 hasSelection:false, 调用方自己决定是否当作"全图"
    async function probeSelectionRect() {
        var out = { hasDoc: false, hasSelection: false };
        try {
            await core.executeAsModal(async function() {
                var doc = app.activeDocument;
                if (!doc) return;
                out.hasDoc = true;
                out.docWidth = Math.round(Number(doc.width) || 0);
                out.docHeight = Math.round(Number(doc.height) || 0);
                try { out.docName = doc.name || ''; } catch(_) {}
                try { out.docId = doc.id; } catch(_) {}
                try {
                    var b = doc.selection && doc.selection.bounds;
                    if (b && typeof b.left === 'number' && (b.right - b.left) > 0 && (b.bottom - b.top) > 0) {
                        out.hasSelection = true;
                        out.selLeft = Math.round(b.left);
                        out.selTop = Math.round(b.top);
                        out.selWidth = Math.round(b.right - b.left);
                        out.selHeight = Math.round(b.bottom - b.top);
                    }
                } catch(_) {}
            }, { commandName: "比例探测" });
        } catch(_) {}
        return out;
    }

    // 同步 PS 矩形选框工具的"样式/宽/高"
    //   做法: 切换到名为 "修图轮椅_<aspect>" 的工具预设
    //   预设必须用户手动建过 (插件首次启动时引导一次)
    //   PS 27.5+ 禁用了 set currentToolOptions, 改预设是唯一合法路径
    //   返回 { success, error?, preset? }
    //
    //   注意 PS 错误模型: 预设不存在时不抛 exception, 而是把错误塞在 batchPlay 返回值数组里
    //   形如: [{ _obj:"error", message:"...", result:-25920 }]
    //   所以要 (1) 用 synchronousExecution 拿到返回值 (2) 检查返回值第一项 _obj 是否 "error"
    async function setMarqueeAspectPreset(aspect) {
        if (!aspect) return { success: false, error: '比例为空' };
        var presetName = '修图轮椅_' + aspect;
        try {
            var result = await core.executeAsModal(async function() {
                return await app.batchPlay([{
                    _obj: "select",
                    _target: [{ _name: presetName, _ref: "toolPreset" }]
                }], { synchronousExecution: true });
            }, { commandName: "同步选框比例 " + aspect });

            // 检查 PS 是否把错误包在返回值里
            if (Array.isArray(result) && result[0] && result[0]._obj === 'error') {
                return { success: false, error: result[0].message || '预设不存在', preset: presetName };
            }
            return { success: true };
        } catch(e) {
            // exception 路径 (真异常 — 比如 modal 锁住等)
            return { success: false, error: e.message || String(e), preset: presetName };
        }
    }

    // 从插件目录读 .tpl 文件并导入工具预设到 PS
    //   .tpl 文件位置: <plugin>/factory_presets_tpl/修图轮椅预设.tpl
    //   做法: PS 内部命令 "set toolPreset append:true _path:<tpl 文件>"
    //   返回 { success, error?, importedFilePath? }
    //
    //   坑: batchPlay 的 _path 接受的是宿主文件系统的绝对路径字符串
    //   UXP 的 plugin folder 默认是 sandbox, 但 .tpl 文件如果是只读资源可以走 nativePath
    async function importMarqueePresets() {
        try {
            // 找 .tpl 文件
            var pluginFolder = await fs.getPluginFolder();
            var tplFolder = null;
            try { tplFolder = await pluginFolder.getEntry('factory_presets_tpl'); }
            catch(_) { return { success: false, error: '插件内未找到 factory_presets_tpl 目录' }; }

            var tplFile = null;
            try { tplFile = await tplFolder.getEntry('修图轮椅预设.tpl'); }
            catch(_) { return { success: false, error: '插件内未找到 修图轮椅预设.tpl' }; }

            // UXP: batchPlay 不收裸路径字符串, 必须用 session token, 否则报 "invalid file token used"
            var tplToken = await fs.createSessionToken(tplFile);

            // 调 batchPlay 导入 (append:true = 追加到现有工具预设, 不覆盖)
            var result = await core.executeAsModal(async function() {
                return await app.batchPlay([{
                    _obj: "set",
                    _target: [
                        { _property: "toolPreset", _ref: "property" },
                        { _enum: "ordinal", _ref: "application", _value: "targetEnum" }
                    ],
                    append: true,
                    to: { _kind: "local", _path: tplToken }
                }], { synchronousExecution: true });
            }, { commandName: "导入工具预设" });

            if (Array.isArray(result) && result[0] && result[0]._obj === 'error') {
                return { success: false, error: result[0].message || '导入失败' };
            }
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    return {
        deselectAll: deselectAll,
        getSelectionAndImage: getSelectionAndImage,
        placeImageToSpecificDoc: placeImageToSpecificDoc,
        placeImagesBatch: placeImagesBatch,
        // 盖印+蒙版(2026-09-14 晚): 抠像/SAM2 走 stampAndApplyMask, 语义分割走 stampAndApplyMaskGroup
        stampAndApplyMask: stampAndApplyMask,
        stampAndApplyMaskGroup: stampAndApplyMaskGroup,
        applyAlphaMaskToLayer: applyAlphaMaskToLayer,
        placePixelsAsNewLayer: placePixelsAsNewLayer,
        createGroupAndMask: createGroupAndMask,
        applyMagentaFixCurveToGroup: applyMagentaFixCurveToGroup,
        getSelectionRectSafe: getSelectionRectSafe,
        applyReturnFeatherMaskToLayer: applyReturnFeatherMaskToLayer,
        calculatePartitionSelections: calculatePartitionSelections,
        handleCaptureRefImage: handleCaptureRefImage,
        handleRecaptureMainImage: handleRecaptureMainImage,
        handleRecaptureRefImage: handleRecaptureRefImage,
        handleRestoreSelection: handleRestoreSelection,
        handleRestoreSelectionFromHistory: handleRestoreSelectionFromHistory,
        handleCaptureForChat: handleCaptureForChat,
        createTeachingMaterials: createTeachingMaterials,
        probeSelectionRect: probeSelectionRect,
        setMarqueeAspectPreset: setMarqueeAspectPreset,
        importMarqueePresets: importMarqueePresets
    };
}

module.exports = { createPSIOModule: createPSIOModule };
