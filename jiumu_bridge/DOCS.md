<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Home Assistant OS 加载项

本加载项处于 experimental 阶段，尚未在 HAOS Supervisor 实机验证。amd64 Docker 验证不能替代 HAOS 安装验证。

本地安装：将本仓库的 `jiumu_bridge` 目录复制到 HAOS 的 `/addons/jiumu_bridge/`，确保其中存在 `config.yaml`。刷新本地应用 / 加载项列表，安装 Jiumu Local Bridge，启动并打开 Web UI。

仓库根目录已有 `repository.yaml`，公开发布后可以将该 Git 仓库 URL 添加到应用商店。私有仓库阶段请使用本地安装方式；当前不承诺商店一键安装已验证。

1. 设备先在九目智联完成 Wi-Fi 配网和账号绑定。
2. 在桥接 Web UI 填账号密码，选择自己的摄像头并保存。
3. 画面在线后填写 HAOS 主机的局域网 IP，生成 RTSP / Frigate 配置。

这里填写的是运行加载项的 HAOS 主机地址，不是摄像头 IP，也不是浏览器地址栏中的 HA 远程域名。Ingress 页面不会自动代填该地址；未填写时会提示补全。只需已有手机完成官方配网，HAOS 主机可以使用有线网络，无需为本加载项额外购买 Wi-Fi、蓝牙或 SD 卡。

安装后确认加载项的“开机启动”已启用。数据保留在加载项的 `/data`；正常重启无需再次登录。不要通过卸载或删除数据来解决普通断流。更换 `rtsp_port` 后，需要重新生成并更新 Frigate / HA 的取流地址；其余账号导入错误处理同 Docker 安装说明。

Ingress 通过 HA 认证；直连管理端口被拒绝。RTSP 使用独立本地凭据，默认端口 18554，可在加载项配置中调整。设备连接参数保存于 `/data`，加载项备份含敏感信息。

设备保存后可将加载项选项 `local_only` 设为 `true` 并重启，禁用厂商账号导入，继续使用保存的凭据。这个选项不会给新摄像头配网，也不会修改路由器或自动隔离摄像头外网。

本加载项提供音视频，不负责人员识别、录像或自动创建 HA 实体。只看画面可用 Generic Camera；检测和录像使用 Frigate 及其 HA 集成。首次账号导入会连接厂商服务；摄像头自身是否联网尚未隔离验证。

保留厂商服务与隔离外网由用户选择，见 [接入与联网方式](../docs/connection-modes.md)。无账号本地绑定仍在研究；加载项当前不会修改路由器，不能通过网页开关自动实现全设备离云。

参考：[HA 应用仓库](https://developers.home-assistant.io/docs/apps/repository/)、[本地应用教程](https://developers.home-assistant.io/docs/apps/tutorial/)、[Frigate HA 集成](https://docs.frigate.video/integrations/home-assistant/)。

已在一次性隔离容器中验证 Ingress 的真实来源地址放行、直连和伪造头拒绝、相对静态资源路径，以及重启后的数据和选项保留；没有访问真实账号。此测试遵循 [HA Ingress 来源要求](https://developers.home-assistant.io/docs/apps/presentation/#ingress)，仍不能替代 Supervisor 安装、HA 登录会话、实际页面及实体创建验收。
