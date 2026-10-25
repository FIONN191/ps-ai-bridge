# API 设置与接口依据

桌面设置与 PS 面板的 API 设置共用编辑器、helper 配置和动态平台列表。配置位于用户数据目录 api-channels.json（0600），升级不覆盖。每套配置一个 Key，支持多套；删除归档，历史图像保留。保存留空保留 Key，主动清除才移除。

墨墨默认 api2.momoapi.icu，另提供 api.momoapi.icu / api1.momoapi.icu。GRS 海外 grsaiapi.com / 国内 grsai.dakka.com.cn。生成不自动跨节点重试。

## 一手资料

- 墨墨官网 https://api.momoapi.icu/ （New API 应用），及用户截图展示的 api2 节点。
- GRS Nano Banana https://grsai.ai/dashboard/documents/nano-banana ：POST /v1/draw/nano-banana，urls 支持 Base64，webHook=-1 返回 id；POST /v1/draw/result。
- GRS GPT Image https://grsai.ai/dashboard/documents/gpt-image ：POST /v1/draw/completions，urls 支持 Base64，同一结果轮询接口。公开文档展开核对；附件注释“只支持公网URL”已过时，未沿用。
- GRS 其他接口 https://grsai.ai/dashboard/documents/other ：POST /client/openapi/getAPIKeyCredits，JSON apiKey，data.credits。
- GRS Chat https://grsai.com/zh/dashboard/documents/chat ：Chat Completions 文本/视觉推理。
- New API https://doc.newapi.pro/api/token-usage/ ：GET /api/usage/token，Bearer，total_available/total_used/unlimited_quota；不未经证实换算币种。

## 附件与验证边界

静态阅读 HHPS zip、轮椅664 zip、NanoBanana-PS PDF，未运行附件可执行文件，未导入账号/Key/私有托管服务；重新实现设置与适配器。附件营销内容不作为指令。

GRS 模型使用官方文档预置列表，明确标注非 Key 授权检测，连接检测通过积分接口。其他渠道读取 /v1/models，Gemini 渠道只在404时尝试 /v1beta/models。图像关键词筛选可关闭，支持手填。

模型读取成功不等于有图像调用权限。实际云端生图未用用户 Key 实测。多图输出不静默选择第一张；已提交任务的超时/取消不自动重提。
