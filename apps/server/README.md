# Server

当前后端为一个零依赖 Node.js HTTP API，服务于“单店、单员工、审批制预约”微信小程序场景。

## 当前能力

- `GET /health`
- `GET /api/v1/gallery`
- `GET /api/v1/availability`
- `POST /api/v1/appointments`
- `GET /api/v1/my/appointments`
- `GET /api/v1/staff/booking-rules`
- `PUT /api/v1/staff/booking-rules`
- `GET /api/v1/staff/appointments`
- `POST /api/v1/staff/appointments/:id/review`

## 存储

后端已接入 SQLite，默认数据库路径：

```text
apps/server/data/miniapp.sqlite
```

可通过环境变量覆盖：

```bash
SQLITE_PATH=/absolute/path/miniapp.sqlite npm run dev:server
```

## 店员鉴权

所有 `/api/v1/staff/*` 接口都要求请求头：

```text
X-Staff-OpenId
```

白名单通过环境变量配置：

```bash
STAFF_OPEN_IDS=staff-openid-demo,staff-openid-lan
```

## 启动

启动前请先确认 Node 版本满足 `>= 22.5.0`，因为当前实现使用了内置模块 `node:sqlite`。

```bash
node -v
```

```bash
npm run dev:server
```

如果启动时看到：

```text
No such built-in module: node:sqlite
```

说明本机 Node 版本过低，请升级到 `Node 22 LTS` 或更高版本后再重试。

## 自测

```bash
npm run test:server
```

自测会覆盖：
- gallery / booking rules 默认种子读取
- booking rules 更新
- 顾客创建预约
- 店员审核通过
- 服务重启后规则 / 预约 / availability 状态保留

## 说明

当前实现优先保证：
- 数据口径与 `docs/API.md` 一致
- SQLite 持久化稳定
- 审批制预约主链路可闭环

后续如复杂度上升，再考虑迁移到更强工程化方案。
