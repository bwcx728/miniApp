# ENV

## 小程序侧

正式开发前需要补齐：

- 微信小程序 `AppID`
- 合法 request 域名
- 合法 uploadFile / downloadFile 域名
- 如需登录，准备 `AppSecret`

### 当前本地联调约定

- 本地开发默认请求：`http://127.0.0.1:3000`
- 微信开发者工具中需勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”后再联调本地接口
- `apps/weapp/project.config.json` 当前使用占位 `appid`，真机调试 / 发布前需替换为真实小程序 `AppID`

## 服务端

### Node.js 运行时要求

- 当前后端依赖内置模块 `node:sqlite`
- 需要 `Node.js >= 22.5.0`
- 推荐使用 `Node 22 LTS` 或更高版本

### 当前已支持的环境变量

- `PORT=3000`
- `SQLITE_PATH=/绝对路径/miniapp.sqlite`
- `STAFF_OPEN_IDS=openid_a,openid_b`

### 变量说明

#### `PORT`
- HTTP 服务端口
- 默认：`3000`

#### `SQLITE_PATH`
- SQLite 数据库文件路径
- 不传时默认使用：`apps/server/data/miniapp.sqlite`
- 建议本地联调沿用默认路径，便于验证重启后的数据保留

#### `STAFF_OPEN_IDS`
- 店员 OpenID 白名单
- 以英文逗号分隔，示例：`staff-openid-demo,staff-openid-lan`
- 所有 `/api/v1/staff/*` 接口都依赖此变量做最小权限校验

## 开发说明

### 本地后端启动

```bash
npm run dev:server
```

启动后默认监听：`http://127.0.0.1:3000`

### SQLite 自测

```bash
npm run test:server
```

该自测会覆盖：
- `/health`
- gallery 种子数据读取
- staff booking rules 读写
- 创建预约默认 `pending`
- 店员审核通过
- 服务重启后规则 / 预约 / availability 状态仍正确保留

## 生产环境提醒

- 真机环境和上线环境需切换为 HTTPS 域名
- 生产环境密钥不写入仓库，只提供 `.env.example`
- SQLite 文件目录需具备可写权限
- 若后续切换为正式登录态，可保留 `/api/v1/staff/*` 路径语义，仅替换鉴权实现
