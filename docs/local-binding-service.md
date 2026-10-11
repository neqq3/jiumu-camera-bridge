<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 本地绑定实验服务

已实现独立 Node.js HTTP 引导和加密 TCP 绑定服务；服务不依赖安卓、厂商账号或 SD 卡，不主动连接厂商。2026-10-11 已在单台 A907-J / 21.120.101.42 上完成重置后的本地配网、设密、新会话认证、音视频取流和 Frigate 恢复。**这是研究部署，不是已交付的用户安装流程；断电冷启动和完整外网隔离仍未验证。** 不应在安装桥接时自动开启，也没有接入 HAOS 正式向导。

## 已实现

- `POST /node/query`：核对单个来源 IPv4、预先选定的真实设备 ID，以及设备提交的加密证明；返回本地 TCP 地址和持久化 token。HTTP 返回明确长度并关闭连接，响应尺寸低于固件的缓冲区上限。
- TCP：小端 8 字节头、AES-256-CBC / PKCS#7；支持拆包与连续报文，密文上限 8192 字节。来源地址、设备 ID、设备 code、固件版本、本地 token 均核对后才接受登记。
- 默认 `observe`：处理登记、心跳和现有 shadow 版本，不发送密码、P2P 身份或设备功能配置。引导响应仍可能使固件保存本地服务器地址/token，不能称为完全无写入的真机观察。
- 显式 `bind-once` 加 `arm: true`：还必须匹配预先配入摄像头的非空本地 uid；发送事件 2 的短 challenge，收到 `allow` 和相同 challenge 的事件 3 请求后才发送一次密码。
- 首先原子保存新密码和“已尝试发送”状态，再写 socket。断线、重复请求、服务重启均不会自动再改密。发送成功、shadow 请求均不标记为“摄像头已接受”。
- 可显式开启固件专用的 `allowP2pBootstrap`，在绑定后通过 shadow 事件 4 下发经过离线校验的 AP 引导参数，识别事件 7 的系统 shadow 确认。默认不发送；确认也不等于媒体就绪。
- 固定缓冲区、会话数量/时长/字节/报文上限、握手/分片/HTTP 绝对超时、慢客户端输出限制；不支持任意命令转发、OTA 或工厂事件。
- 摄像头重启可能留下未关闭的 TCP 连接；允许一个待认证连接进入，且仅在完整登记认证通过后替换旧会话。错误 token 或空闲连接不能踢掉现有会话。

这套旧协议使用固定的协议密钥，来源 IP、设备 ID 和加密字段不能提供现代双向认证，也不防同网段攻击者冒充。服务仅用于用户自己的单台摄像头，应限制在可信实验网络，不能暴露到公网。

## 启动配置

入口是 `jiumu_bridge/local-binding.cjs`，只接受一个配置文件路径，不通过命令行传密码。以下值为示例，摄像头 ID 需来自本地发现/状态信息；这里的 `did` 是 HTTP 引导用的真实设备 ID，不是可能不同的 HLP / P2P DID。

```json
{
  "mode": "observe",
  "listen": "127.0.0.1",
  "advertiseIp": "127.0.0.1",
  "httpPort": 18084,
  "tcpPort": 18085,
  "materialFile": "protocol-material.json",
  "dataDir": "state",
  "learnCodeFromBootstrap": true,
  "target": {
    "sourceIp": "127.0.0.1",
    "did": "REPLACE-REAL-DEVICE-ID",
    "firmware": "21.120.101.42",
    "uid": "REPLACE-LOCAL-OWNER"
  }
}
```

`learnCodeFromBootstrap` 允许从已选定摄像头自己的合法引导请求中取得 code，并保存在本地；首次保存后拒绝替换，不要求用户去 APP 提取。也可预先配置 `target.code`。这不是发现任意摄像头后自动接管的服务：仍需先确认单台设备身份和实际 LAN IP。

协议材料文件包含 `profile: "bk7252n-21.120.101.42"`、`keyHex`（64 位十六进制）、`ivHex`（32 位十六进制）。本实验由已核验哈希的用户固件生成，文件不随源码发布。公开安装包的协议材料交付方式尚未完成；目前仍是研究入口，不能宣称普通用户已能一键无账号接入。

首次 AP 配网会清除 `did` / `license` / `initString`，仅设密码不能启动 LAN P2P。本次在材料文件加入 `p2pBootstrap`（`did`、`license`、`address`、`version`），并在服务配置同时启用 `mode: "bind-once"`、`arm: true`、`allowP2pBootstrap: true`。参数来自固件自身的共享 AP 默认值，**不是新签发的唯一设备云身份**。连接必须限定目标 IP，再核对真实设备 ID；多摄像头、广播重名、厂商共存尚未验证。不能把共享默认值当作生产环境的唯一身份或用于恢复厂商服务。

```sh
node jiumu_bridge/local-binding.cjs /path/to/private/binding.json
node --test --test-timeout=20000 scripts/binding.test.cjs
```

默认仅回环监听。LAN 试验需要显式 `allowLan: true`、绑定具体 LAN 地址、正确的单摄像头 `sourceIp` 和可达 `advertiseIp`；拒绝 `0.0.0.0` 和公网地址。配置和状态仅在本地保存，未加密；Linux 创建权限为文件 0600 / 目录 0700，Windows 必须靠目录 ACL 控制访问。日志只含事件名、计数及监听信息，不含请求正文、ID、uid、token 或密码。

状态目录不能随意清空。异常终止遗留 `binding.lock` 时服务拒绝启动：先确认没有另一个服务进程，再处理锁文件，保留 `binding-state.json`。存在 `delivery-attempted` 时应先使用该文件中已保存的密码验证摄像头，不能靠删除状态重试改密。

## Docker 实验入口

`binding.Dockerfile` 只复制该服务所需的原创 JS 模块。`compose.binding-lab.yaml` 提供显式 profile，默认不随媒体桥接启动。先准备 `data/binding-config/binding.json` 和协议材料，配置 `dataDir: "/data"`。初始仍用回环地址测试：

```sh
docker compose -f compose.binding-lab.yaml --profile binding-lab build
docker compose -f compose.binding-lab.yaml --profile binding-lab up
```

此模板使用 Linux host 网络以保留来源 IP；未在 Docker Desktop 或 HAOS Supervisor 验证。镜像以 UID/GID 1000 运行，挂载配置须对其可读，状态目录须对其可写；保持配置 0600、目录 0700，并匹配实际所有者。默认仅监听高位回环端口，不修改主机 DNS、防火墙或路由。真机引导访问 HTTP 80，DNS A 记录不能改变端口；需要另行选择无冲突服务地址及部署方式。本模板删除了所有 capabilities，若实际部署要监听 80，需核对宿主内核的非特权端口设置或只增加必要的 `NET_BIND_SERVICE`，不能因此启用 privileged。

本次 NAS 使用专用 IPvlan L2 地址，镜像基于本地已有 Node/媒体运行时构建，非 root、只读根文件系统、无 capabilities。IPvlan 默认隔离宿主与容器之间的直接访问，不能把这种地址直接假定为同机 Frigate 可访问的视频出口；实测媒体桥接保留 host 网络及原 RTSP 端口。

## 验证与真机门槛

本机测试使用独立编码的模拟客户端，覆盖 HTTP/TCP 正常往返、错误身份、拆包/粘包、畸形输入、来源限制、单次绑定、存储故障、重启、端口冲突与退出清理。它不是固件仿真器，也不能证明真实摄像头已接受响应。

真机前按 [单设备路由方案](router-routing.md) 确认设备 LAN MAC/IP、服务地址/HTTP 80、规则备份与回程路径。先用观察模式核对真实引导/登记，再启用单次绑定。必须先保存 Wi-Fi 再设密码：分析到的初始 AP 配网流程会恢复部分默认配置。

收到绑定响应后，仍需分别验证 HLP 认证、实际图像解码、桥接 RTSP、Frigate、摄像头断电重启与 WAN 隔离。厂商共存模式不应使用本地改密，见 [模式选择](connection-modes.md)。

## 单台真机结果

1. 初始 AP 中读取真实设备身份、station MAC 和版本，使用本地生成的所有者编号下发 Wi-Fi。测试中的安卓设备只充当临时 Wi-Fi/UDP 适配器，没有运行厂商 APP；手机或桌面配网助手尚待产品化。
2. 配网 ACK 后保持会话：固件先回复，再等待约 1 秒读取配置。立即关闭会话曾导致“返回成功但未入网”；保持 25 秒的实验成功入网。
3. 路由器只对目标 station 地址配置静态租约、DNS 和 IPv4 WAN 限制。摄像头真实连接本地 HTTP/TCP 服务，完成 code/token/uid 检查、challenge 和单次密码下发。
4. 首次 LAN P2P 参数为空；明确启用上述 AP 引导参数后，收到系统 shadow ACK。之后等待 SDK 初始化，并用新密码建立独立媒体会话，不能以 ACK 代替此步骤。
5. NAS 主机 15 秒测试取得 119 个视频帧、132 个音频帧，真实设备身份匹配，非法包和丢弃计数均为 0；另一连接实际解码 30 帧 640×480 JPEG。现有桥接使用新凭据后，Frigate 再次取得实时画面。
6. WAN 限制下还发现 P2P TCP 阻塞和客户端遗漏累计确认两处问题，处理过程见 [协议研究](research/protocol.md)。修复后、重启前的三分钟采样持续收帧且未重连；软件重启后使用同一密码恢复，但启动阶段仍发生一次自动重连，之后恢复取流。仍需后续冷启动和长期验证。

此次不登录厂商账号、不读取 APP 缓存、无 SD 卡、未刷机。IPv4 规则已启用且其他客户端 DNS 仍返回原厂地址；尚无覆盖所有出站路径及 IPv6 的抓包证据，不能据此宣称摄像头完全不向厂商发送数据。
