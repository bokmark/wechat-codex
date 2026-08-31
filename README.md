# WeChat Codex

通过微信控制这台电脑上的 Codex，并在任务完成、失败或需要审批时收到通知。你可以在微信里新建任务、继续对话、切换项目和处理审批。

## 30 秒开始

准备好以下环境：

- 已安装并登录 Codex CLI
- Node.js 18 或更高版本
- 可以使用微信 ClawBot 的微信账号

### 方法一：直接让 Codex 安装（推荐）

把下面这段话发送给 Codex：

```text
请从 GitHub marketplace bokmark/wechat-codex 安装 wechat-codex 插件。安装完成后告诉我新建一个任务，不要在当前任务里继续配置。
```

插件安装完成后，**新建一个 Codex 任务**，再发送：

```text
连接我的微信，并监控当前项目。
```

如果希望同时监控多个项目，可以改成：

```text
连接我的微信，并把我保存的所有项目加入监控。
```

接下来只需要：

1. 允许 Codex 安装或更新当前用户的后台服务。
2. 打开 Codex 给出的微信授权链接，并在微信中确认。
3. 给微信机器人发送 `help`。

Codex 会自动选择当前项目、生成配置、部署完整运行程序、启动后台服务并检查运行状态。无需 clone 仓库、运行 `npm install`、执行 `npm start` 或手动编辑 JSON。

### 方法二：手动安装插件

如果你更习惯终端，只需运行：

```sh
codex plugin marketplace add bokmark/wechat-codex --ref main
codex plugin add wechat-codex@wechat-codex
```

然后新建 Codex 任务并发送：

```text
连接我的微信，并监控当前项目。
```

更新插件时运行：

```sh
codex plugin marketplace upgrade wechat-codex
codex plugin add wechat-codex@wechat-codex
```

更新后也应新建任务，让 Codex 加载新版技能。

## 常用的 Codex 提示词

不需要记住服务命令，直接告诉 Codex 目标即可：

```text
检查微信 Codex 桥接服务是否正常。
重启微信 Codex 桥接服务。
把当前项目加入微信监控。
把我保存的所有项目加入微信监控。
查看微信 Codex 最近的必要日志，并说明问题原因。
```

添加新项目时，Codex 会保留已有项目和微信登录状态。遇到多个可能的项目时，它会先让你选择，不会扫描整台电脑猜测路径。

## 微信里怎么用

安装完成后，直接给机器人发送任务，例如：

```text
检查当前项目为什么测试失败
修复登录页面的报错并补测试
#2 继续处理刚才的代码审查问题
```

常用命令：

```text
help          查看完整使用指引（也支持 /help、帮助）
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
```

直接回复文字会继续当前任务。如果任务仍在运行，这条消息会作为补充要求加入当前回合；任务完成后，最终回复会自动发送到微信。

## 支持平台

- macOS：使用当前用户的 LaunchAgent，登录系统后自动启动。
- Linux：使用当前用户的 systemd 服务；需要可用的 `systemctl --user` 会话。
- Windows：使用当前用户的任务计划程序；兼容 PATH 中的 `codex.exe`、`codex.cmd` 和 `codex.bat`。

安装器会自动选择后台服务方式，不需要用户判断系统类型。

## 安全边界

- 使用腾讯公开的微信 ClawBot/iLink 通道，不模拟个人微信客户端。
- Codex 和项目文件仍在本机运行，本项目不运营中转服务器。
- 微信登录凭据只保存在当前用户目录，并限制为当前系统用户读取。
- 默认只接受扫码登录者自己的消息。
- 项目只允许 `read-only` 和 `workspace-write` 沙箱，不接受 `danger-full-access`。
- 命令执行和文件变更仍可在微信中逐项审批。
- 插件不会绕过系统操作确认或微信首次授权。

## Desktop/CLI 任务通知

桥接器默认每 15 秒只读检查已配置项目下的 Desktop 和 CLI 任务。首次启动只建立历史基线，不会把旧结果全部发到微信；之后新出现的 `completed`、`failed` 和 `interrupted` 回合会自动通知。

微信个人机器人没有可靠的消息已读回执，因此通知会进入持久化的未读收件箱：使用 `/unread M1` 查看，或使用 `/read M1`、`/read all` 标记已读。如果机器人还没收到过你的消息，通知会先排队，取得当前会话上下文后再补发。

独立运行的微信桥接器可以发现 Desktop/CLI 保存的任务，但无法可靠读取另一个 App Server 进程的实时状态。为避免两个客户端同时修改同一对话：

- `/active` 对 Desktop/CLI 任务显示“尚未收尾”，不会冒充精确实时状态。
- `/recent` 为发现的任务分配 `C1`、`C2` 等编号。
- `/use C1` 会创建独立微信分支，保留原历史但不修改 Desktop 原任务。

## 开发者模式

下面的方式只适合参与本项目开发或排查插件安装器本身。普通用户请使用前面的插件安装流程。

```sh
git clone https://github.com/bokmark/wechat-codex.git
cd wechat-codex
cp config.example.json config.json
```

Windows PowerShell 使用：

```powershell
Copy-Item config.example.json config.json
```

编辑 `config.json`，为项目填写绝对路径，然后运行：

```sh
npm run doctor
npm run login
npm start
```

不要同时启动多个实例，否则多个长轮询进程会争用同一同步游标。

运行测试：

```sh
npm test
npm run test:codex
```

`npm test` 是离线单元测试；`npm run test:codex` 会真实启动本机 Codex App Server 并验证初始化，但不会创建任务或修改项目文件。

## 本地数据位置

- 微信凭据：`~/.wechat-codex/credentials.json`
- 项目配置：`~/.wechat-codex/config.json`
- 任务映射与未读状态：`~/.wechat-codex/state.json`
- 插件部署的稳定运行文件：`~/.local/share/wechat-codex`

## 协议来源

微信连接器参考腾讯官方开源项目 `Tencent/openclaw-weixin` 的 iLink 协议实现，并按其 MIT 许可证在 [THIRD_PARTY.md](./THIRD_PARTY.md) 中致谢。本项目没有把该项目作为运行时依赖。
