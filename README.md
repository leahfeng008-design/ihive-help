# iHive 帮助助手（恢复版）

从现有公开部署重建的可运行版本，保持原站交互与 `/api/chat` 响应格式。

## 本地运行

```bash
pnpm dev
```

不配置密钥时，接口使用少量内置恢复文档验证问答流程。配置 OpenRouter 和飞书应用凭证后，会使用关键词与语义向量的混合检索生成回答。

## 飞书知识库

同步范围包括帮助知识库、PRD 文件夹和模块分工表。同步器把内容写成“目录 → 子目录/文章 → 子文章/段落”的本地知识树：目录和文章都有摘要，段落保留原始正文块，关联图片直接挂在对应段落下。随后为目录、文章和段落分别建立 OpenRouter 向量索引。不要提交 `FEISHU_APP_SECRET`。

线上入口支持飞书 OAuth 登录。登录成功后会先验证当前飞书账号是否能读取目标知识库，只有验证通过才会创建加密登录会话。生产环境需设置 `FEISHU_AUTH_REQUIRED=true`、`FEISHU_REDIRECT_URI` 和 `FEISHU_COOKIE_SECRET`。

执行 `pnpm sync:feishu` 可增量刷新：

- `data/knowledge.json`：完整树状知识库和段落图片关系；
- `data/catalog.json`：目录、文章标题与摘要组成的轻量目录；
- `data/vector-index.json`：逐节点向量缓存，只为新增或变化的节点重新生成向量；向量使用 int16/base64 压缩，降低部署体积；
- `public/kb-images/`：按飞书文件 token 去重的本地图片缓存。

问答接口按“目录 → 文章 → 段落”逐级缩小候选范围，再对精确段落进行关键词与向量混合排序。命中的段落带图时，响应会强制包含对应图片标记。现有 Codex 巡检每周五 20:00 同步帮助知识库、PRD 和模块分工表，也可通过 `pnpm sync:feishu` 手动触发；线上内容在发布后更新。

模块分工表使用 https://pcnpuds47gj5.feishu.cn/base/IQTIbgVvIa9thdsuOi0cbUXanRc?table=tblG1Pi9DMfjY97O&view=vewyB77k2Y ，读取完整表格，不受视图过滤影响。负责人问答按一级、二级模块直接读取产品经理、设计师和帮助文档负责人（显示为维护人），保留原表姓名；空字段显示“未填写”，未匹配模块时要求补充模块名。一级模块返回各子模块分工，不推断统一负责人；回答附原表链接。支持“那设计师呢”等连续追问，不调用模型猜测人员。

`pnpm sync:feishu --assignment-only` 可单独刷新分工表，同时保留其他来源。默认全量同步及现有每周巡检仍包括全部三个来源，失败时保留上次完整缓存。巡检禁用新向量生成；分工查询不依赖向量。验证分工问答可运行 `node scripts/test-chat-assignments.mjs`。

## 问答回归检查

```bash
node scripts/test-chat-images.mjs
node scripts/evaluate-chat.mjs --assert
```

默认不调用外部服务：使用真实本地知识库、关键词检索和实际问答接口，检查连续追问、客户端/方法选择、精简输出、段落图片以及模型故障兜底。模型返回结构化段落引用，后端把可信来源图片插在对应回答块之后。模拟模型响应测试不代表真实模型质量已验证。

`data/image-context.json` 保存经过图片内容核对的关联修正（组合图共享范围、截图对应步骤、客户端）。它不修改飞书原文；重新同步后若正文变化，应复查这些关联。

只有获得发送测试问题和知识库片段到现有 OpenRouter 服务的授权后，才运行 `node --env-file=.env.local scripts/evaluate-chat.mjs --live`。可用 `EVAL_SCENARIOS` 限定场景，用 `EVAL_OUTPUT` 指定本地报告路径。

图片来源限定为帮助知识库：PRD 只同步文字，不下载图片；问答检索会过滤已有缓存中的非帮助文档图片。

负责人查询同时同步“按照模块分”（tblinkja1AwTvKno）的二级模块与问题负责人。模块负责人查询同时展示两表结果：帮助文档维护表提供产品、设计及帮助文档维护人；按照模块分提供问题负责人。两表各自保留来源链接，角色分别标明，避免把维护人与问题负责人混为一谈。
