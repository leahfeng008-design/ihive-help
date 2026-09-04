# iHive 帮助助手（恢复版）

从现有公开部署重建的可运行版本，保持原站交互与 `/api/chat` 响应格式。

## 本地运行

```bash
pnpm dev
```

不配置密钥时，接口使用少量内置恢复文档验证问答流程。配置 OpenRouter 和飞书应用凭证后，会使用关键词与语义向量的混合检索生成回答。

## 飞书知识库

同步范围包括帮助知识库、PRD 文件夹和模块分工表。同步器递归读取目录、按来源与父级目录分类、把正文分块、下载关联图片，并通过 OpenRouter Embeddings 建立向量索引。不要提交 `FEISHU_APP_SECRET`。

线上入口支持飞书 OAuth 登录。登录成功后会先验证当前飞书账号是否能读取目标知识库，只有验证通过才会创建加密登录会话。生产环境需设置 `FEISHU_AUTH_REQUIRED=true`、`FEISHU_REDIRECT_URI` 和 `FEISHU_COOKIE_SECRET`。

执行 `pnpm sync:feishu` 可增量刷新 `data/knowledge.json`、`data/catalog.json` 和 `data/vector-index.json`。内容未变化时不会重复生成向量。
