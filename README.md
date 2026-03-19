# miniApp

美甲预约微信小程序，由 OpenClaw 团队协作开发。

## 当前产品范围（V1）

围绕“单店、单员工、审批制预约”打通最小业务闭环：

- 顾客查看门店氛围与返图案例
- 顾客按规则选择日期 / 时间段并提交预约申请
- 顾客按手机号查看自己的预约状态
- 店员配置预约规则
- 店员审核预约申请（通过 / 拒绝）
- 后端使用 SQLite 持久化返图、规则和预约数据

## 技术路线

- 前端：原生微信小程序
- 后端：Node.js 零依赖 HTTP API
- 存储：SQLite
- 协作：文档优先，架构 / 接口 / 任务先行

## 目录结构

```text
miniApp/
├── apps/
│   ├── weapp/          # 微信小程序前端
│   └── server/         # Node.js API + SQLite
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── TASKS.md
│   ├── ENV.md
│   ├── WORKFLOW.md
│   └── UAT_GUIDE.md
└── tools/
    └── check-docs.mjs
```

## 当前状态

- V1 文档口径已统一到“单店、单员工、审批制预约”
- 顾客端与店员端页面首版已落地
- 后端 gallery / availability / appointments / staff rules / staff review 接口已落地
- SQLite 持久化已接入，服务重启后数据可保留
- 已完成首轮本地后端自测，待微信开发者工具侧人工验收

## 本地启动

### 0. Node.js 版本要求

后端当前使用内置模块 `node:sqlite`，请使用 `Node.js >= 22.5.0`（推荐 `22 LTS` 或更高版本）。

可先执行：

```bash
node -v
```

### 1. 启动后端

```bash
npm run dev:server
```

默认监听：`http://127.0.0.1:3000`

如需指定数据库文件路径：

```bash
SQLITE_PATH=/absolute/path/miniapp.sqlite npm run dev:server
```

如需指定店员 OpenID 白名单：

```bash
STAFF_OPEN_IDS=staff-openid-demo npm run dev:server
```

### 2. 运行后端自测

```bash
npm run test:server
```

### 3. 打开微信开发者工具

使用微信开发者工具打开目录：

```text
apps/weapp
```

联调前请参考：
- `docs/ENV.md`
- `docs/UAT_GUIDE.md`

## 关键页面

### 顾客端
- `pages/home/index`
- `pages/booking/index`
- `pages/my-bookings/index`

### 店员端
- `pages/staff/rules/index`
- `pages/staff/appointments/index`

## 验收建议

- 后端稳定性与持久化：先执行 `npm run test:server`
- 页面与交互验收：按 `docs/UAT_GUIDE.md` 在微信开发者工具中逐步验证

## 说明

- 本地开发默认请求 `http://127.0.0.1:3000`
- 若看到 `No such built-in module: node:sqlite`，说明 Node 版本过低，请升级到 `Node.js >= 22.5.0`
- 真机调试和上线前，需要在微信公众平台配置合法域名
- 当前 `AppID` 仍为占位值，真机调试 / 发布前需替换
