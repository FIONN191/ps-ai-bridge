# V7 卡片接口契约（ui-pure/cards/_CONTRACT.md）

> 2026-10-06 建立。这是**每张卡片必须遵守的规矩**，也是"总管理员"（card-manager.js）
> 用来统一调度、统一检查的依据。
>
> 建这份契约的原因：在这之前，9 张一级卡的内容渲染器散在 6 个地方
> （`ui.html` 静态 HTML / `ZONE_SETS` / `route-registry.js` / `main-card-shortcuts.js` /
> 各卡自己的 `*-card.js` / `ui.html` 里的 `isXxxCard()` 判断），
> **要定位一张卡得横跨 6 处搜**。契约把"一张卡该长什么样"收敛成一处。

---

## 一、卡片是一个对象，只有 5 个字段

每张卡对外暴露一个冻结对象，**多余的字段一律不要加**：

```js
{
  id:       'generation',        // 卡片 id，必须和 card-registry.js 里的一致
  index:    0,                   // 一级卡的堆叠序（data-b），0 在最上面
  name:     '生成',               // 卡面显示名
  levels:   'main-zone',         // 'main-zone'（有二级格）| 'main-bigzone'（单张大二级）
  mount(body, zone)              // 渲染入口，唯一必须实现的函数
}
```

## 二、`mount()` 的三条硬规矩

### 规矩 1 · 只往 body 里画，不碰外面

`mount(body, zone)` 拿到的是**三级面板的容器**（`#dcBody`）。
**它只能动 `body` 里面的东西** —— 不许 `document.getElementById` 去摸别的卡片、
不许改 `body` 的祖先、不许往 `document.body` 挂东西。

- ❌ `document.querySelector('.some-global')` → 越界
- ✅ `body.querySelector('[data-xxx]')` → 对

**为什么**：拆开的目的就是"改 A 卡不会碰坏 B 卡"。越界一处，这个目的就没了。

### 规矩 2 · 挂了什么，就要负责收拾干净

凡是**绑了监听、起了定时器、订阅了事件**的，必须用 `retain(body, cleanup)` 登记：

```js
function mount(body, zone) {
  const timer = setInterval(tick, 1000);
  retain(body, () => clearInterval(timer));   // ← 必须
}
```

**为什么**：卡片是反复挂载/卸载的（切卡、切分区都会重挂）。
不登记 = 监听器越挂越多，同一件事被触发 N 次。
（这是本项目的经典事故类型，见过不止一次：绑定函数被重绘函数调用 → 监听翻倍 → 整机卡死。）

### 规矩 3 · 重复挂载必须安全

同一个 `body` 可能被连续 `mount` 两次。**开头先 `reset(body)`**，
或者自己检查 `body.dataset.cardRoute` 是不是已经是当前路由：

```js
function mount(body, zone) {
  prepareDetail(body, 'generation:' + zone);   // 路由没变就直接 return
  reset(body);                                  // 路由变了才清空重画
  ... 画内容 ...
}
```

**为什么**：`ui.html` 里 `fillDetailBody()` 在切卡/切分区时都会调过来，
不防重就会出现"两份内容叠在一起"。

## 三、允许用的公共零件（都由 card-architecture.js 提供）

**别自己造轮子，这些是统一外观的唯一来源**：

| 零件 | 用途 | 谁提供 |
|---|---|---|
| `section(title, content, anchor)` | 一个标准分节 | card-architecture |
| `foldSection({title, note, content, anchor, open})` | 一个可折叠分节 | card-architecture |
| `retain(body, fn)` | 登记清理函数 | card-architecture |
| `reset(body)` | 清空并释放（含所有 retained） | card-architecture |
| `helpify(container)` | 给 `[data-help-text]` 挂帮助气泡 | card-architecture |
| `routeButton(label, route)` | 跳转到某条路由的按钮 | card-architecture |
| `host.navigate(card, zone, options)` | 主动跳卡 | card-architecture |

⚠ **`data-*` 与锚点一个都不许删**：`data-service-tab` / `data-service-page` /
`data-sec-anchor` / `[data-setting]` / `id="setsec-*"`。
它们被全文档扫描回填（`main-card-shortcuts.js`），删了会导致**卡面值静默变旧**。

⚠ **折叠"隐藏不移除"**：用 `[hidden]` / `display:none` 收起，
DOM、`data-*`、`[data-setting]` **全部保留**。

## 四、状态只有一个出口

**任何卡片不许自己判断"引擎在不在跑""模型齐不齐"** —— 一律读 `V7EngineStatus`。

先例（代码注释里写着）：`engines-core.js` 曾两处各算一遍档位，结果两边漂移。
**两处算 = 一定漂。**

## 五、缺东西 = 状态，不是报错

按 `CLAUDE.md` 铁律 15：

- **缺环境 / 缺模型 / 引擎没起** → 显示成**状态文字**（"未安装""未启动"）
- **只有用户主动操作失败** → 才进报错堆（`ERR.report`）

## 六、注册与调度

卡片文件加载后**自己注册进总管理员**：

```js
V7CardManager.register({
  id: 'generation',
  index: 0,
  name: '生成',
  levels: 'main-zone',
  mount(body, zone) { ... }
});
```

总管理员负责：
1. 按 `index` 排好 9 张卡；
2. 提供 `mount(id, body, zone)` 给 `ui.html` 分发用；
3. 跑 `audit()` 自检（字段齐不齐、id 有没有重复、有没有越界引用）；
4. 一张卡 mount 抛错时**只影响这一张卡**，其余照常。

## 七、加一张新卡的步骤

1. 在 `cards/` 下建 `card-<id>.js`，照上面写；
2. 在 `card-registry.js` 里补一条（地图）；
3. 在 `ui.html` 的 script 列表里加一行；
4. 跑 `node scripts/check-card-registry.cjs` 和 `node scripts/_verify-150-all.cjs`；
5. 跑 `node scripts/check-card-contract.cjs`（本契约的自动检查）。

**注意**：`ui.html` 改动要重编 exe（6 秒）——
而且 **ui.html 是独占区**，同一时间只能有一个对话改它。
