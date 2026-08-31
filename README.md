# WeChat Codex

通过微信 ClawBot 控制这台电脑上的 Codex。微信消息会进入本机 `codex app-server`；任务完成、失败或请求审批时，结果会主动发回微信。同一任务可以继续对话，也可以在多个任务之间切换。

## Codex 插件安装（推荐）

本仓库同时是一个 Codex 插件市场。安装 `wechat-codex` 插件后，在新任务里说“连接我的微信，并监控当前项目”，Codex 会引导完成一次微信授权，并在 macOS 上安装自动启动的后台服务。以后不需要再运行 `npm start`。

插件不能也不应该绕过微信的首次授权，但会自动完成运行文件部署、项目配置、后台启动和后续更新。手动安装方式保留为开发和故障排查入口。

## 安全边界

- 使用腾讯公开的微信 ClawBot/iLink 通道，不模拟个人微信客户端。
- Codex 仍在本机运行，项目文件和登录态不会传给本项目的第三方服务器。
- 默认只接受扫码登录者自己的消息。
- 只允许 `read-only` 和 `workspace-write` 沙箱；项目配置不接受 `danger-full-access`。
- 命令执行和文件变更可在微信中逐项审批。

## 准备

需要 Node.js 18+、已经安装并登录的 Codex CLI，以及能运行微信 ClawBot 的微信账号。

```sh
cp config.example.json config.json
```

编辑 `config.json`，把项目路径换成这台电脑上的绝对路径。可以配置多个项目：

```json
{
  "defaultProject": "wechat-codex",
  "projects": {
    "wechat-codex": {
      "path": "/Users/you/project/wechat-codex",
      "sandbox": "workspace-write",
      "approvalPolicy": "on-request"
    }
  }
}
```

## 登录与启动

```sh
npm run doctor
npm run login
npm start
```

`npm run login` 会输出腾讯 iLink 登录地址。用微信打开并确认后，凭据会以仅当前系统用户可读的权限保存在 `~/.wechat-codex/credentials.json`。运行状态和任务映射保存在同目录的 `state.json`。

服务启动后，直接给机器人发送文字即可创建第一个 Codex 任务。

## 微信命令

```text
/new [项目]  新建任务
/tasks       查看最近任务
/active      查看运行中或尚未收尾的任务
/recent      发现配置项目下的 Desktop/CLI 最近任务
/unread      查看未读的任务完成消息
/unread M1   查看一条消息并标记已读
/read M1     标记一条消息已读（all 表示全部）
/use 2       切换到任务 #2
/use C1      将 Desktop/CLI 任务安全导入为微信分支
/status      查看当前任务状态
/cancel      停止当前运行
/approve A1  允许待审批操作
/deny A1     拒绝待审批操作
#2 继续补测试  直接给任务 #2 发消息
```

直接回复文字会继续当前任务；如果任务仍在运行，这条消息会作为补充要求加入当前回合。任务完成后会自动推送最终回复。

### Desktop/CLI 完成推送

桥接器默认每 15 秒只读检查配置项目下的 Desktop 和 CLI 任务。首次启动会建立历史基线，不会把旧任务结果全部发到微信；之后新出现的 `completed`、`failed` 和 `interrupted` 回合会自动推送最终回复。

```json
{
  "externalMonitor": {
    "enabled": true,
    "intervalMs": 15000,
    "maxThreads": 50,
    "notifyInterrupted": true
  }
}
```

已通知的回合编号、未读收件箱和尚未发送的通知会持久化到 `~/.wechat-codex/state.json`。微信个人机器人通道不提供可靠的消息已读回执，因此这里采用显式已读：完成通知即进入未读收件箱；发送 `/unread M1` 查看详情，或用 `/read M1`、`/read all` 标记已读。如果机器人还没收到过你的微信消息，通知会先排队；取得当前 `context_token` 后自动补发。监控只读取任务历史，不会恢复、分叉或修改 Desktop/CLI 对话。

### Desktop/CLI 任务边界

Codex App Server 的运行状态属于单个服务进程：独立启动的微信桥接器可以发现 Desktop/CLI 保存的任务，但不能可靠读取另一个 App Server 进程里的实时 `active` 状态。为避免两个客户端并发写同一条对话：

- `/active` 把微信桥接器自身任务列为“确认正在运行”；对 Desktop/CLI，只显示最近检查到 `completedAt` 仍为空的“尚未收尾”回合，并明确提示它也可能是异常退出，不能冒充精确实时状态。
- `/recent` 读取配置项目内最近的 Desktop/CLI 任务，并分配 `C1`、`C2` 等编号。
- `/use C1` 使用 `thread/fork` 创建独立微信分支，保留原对话历史但不修改 Desktop 原任务。

这是有意的安全设计，不会根据文件更新时间猜测任务是否仍在运行。

## 验证

```sh
npm test
npm run test:codex
```

第一条只运行离线单元测试；第二条会真实启动本机 Codex App Server 并验证初始化，但不会创建任务或修改文件。

## 后台运行

当前版本先以前台进程运行，便于观察首次接入。确认扫码和收发消息都正常后，可再用 macOS LaunchAgent、systemd 或进程管理器托管。不要同时启动多个实例，否则多个长轮询进程会争用同一同步游标。

## 协议来源

微信连接器参考腾讯官方开源项目 `Tencent/openclaw-weixin` 的 iLink 协议实现，并按其 MIT 许可证在 [THIRD_PARTY.md](./THIRD_PARTY.md) 中致谢。本项目没有把该项目作为运行时依赖。
