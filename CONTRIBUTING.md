<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 贡献

请在 PR 中说明变更目的、测试设备 / 固件版本、验证方式和尚未验证之处。贡献代码适用 Apache-2.0，原创文档正文适用 CC BY 4.0，范围以 LICENSE 为准；提交者须有权贡献材料。

不要提交厂商二进制、反编译源码或未知许可的复制代码。引用第三方实现时先标明来源及许可证。研究结论需区分静态推断、实际通信、真实媒体解码。

不要提交账号、设备 ID、MAC、Wi-Fi 名称 / 密码、云 token、真实 RTSP URL、抓包、录像或 APP 缓存。请使用明显虚构的示例和人工构造的测试数据。

检查 JavaScript 语法与文档本地链接：

```sh
node scripts/check.cjs
```

账号导入的离线测试使用合成数据，不需要厂商账号。时限测试包含两次约 15 秒等待，分别模拟 DNS 未返回和响应持续发送少量数据，整体约 30 秒：

```sh
node --test --test-concurrency=1 scripts/onboarding.test.cjs scripts/onboarding-deadline.test.cjs scripts/local-mode.test.cjs
```

测试不会查询厂商 DNS 或登录厂商；慢响应使用回环 HTTP，仅验证总时限与连接清理，不代表 TLS 或真实账号验收。

页面请求恢复测试执行实际页面脚本，使用合成 DOM、请求和可控时钟，检查登录响应挂起、预览挂起及状态恢复，不访问网络：

```sh
node --test scripts/setup-page-deadline.test.cjs
```

这项测试不能替代浏览器或 HAOS Ingress 实测。

从镜像验证首次安装与 RTSP 故障恢复（Linux Docker）：

```sh
docker build -t jiumu-install-candidate ./jiumu_bridge
sh scripts/test-install.sh jiumu-install-candidate
```

脚本建立独立的 `network=none` 容器及空数据卷，检查未导入设备时的界面与 RTSP 就绪、实际停止 RTSP 子进程后的自动恢复、容器重启后凭据保留。每次检查最多 30 秒，结束后只清理自己创建的容器和卷；镜像保留供开发者继续测试。没有厂商请求、真实账号或摄像头访问。`container-smoke.cjs` 会主动结束测试容器内的 RTSP 子进程，禁止在正式容器中运行。

本地绑定服务的模拟客户端测试只使用本机回环地址，不访问摄像头或厂商：

```sh
node --test --test-timeout=20000 scripts/binding.test.cjs
```

公开 issue 适合兼容性与非敏感错误信息。涉及凭据泄露或认证问题请先查看 SECURITY.md，不要贴真实数据。

Ingress 测试使用真正的 socket 来源地址，不通过伪造转发头或修改产品认证逻辑来放行。开发者需准备含 Node.js 24 与 Python 3 的 Linux 测试镜像，公开源码目录对测试进程可读，然后从仓库根目录执行（将 `TEST_IMAGE` 替换为该镜像名）：

```sh
docker run --rm --network none --cap-drop ALL --cap-add NET_ADMIN \
  --read-only --security-opt no-new-privileges \
  --tmpfs /tmp:size=16m --memory 128m --pids-limit 48 \
  -e INGRESS_SOCKET_TEST=1 -v "$PWD:/test:ro" -w /test \
  TEST_IMAGE python3 scripts/ingress-netns.py
```

`NET_ADMIN` 只用于这次无网络测试容器的回环地址，产品加载项不需要它。不要将测试命令改为 host 网络；启动器会拒绝存在其他网络接口的环境。测试自身 40 秒超时，未挂载生产数据，不连接厂商或摄像头。该测试不表示完成了 HAOS Supervisor 安装。


媒体恢复测试需 Linux、FFmpeg 和 go2rtc，桥接编码已分别测试 Debian FFmpeg 5.1.9 和 FFmpeg 7.0.2。建议在无网络、未挂载生产数据的临时容器中执行。生命周期检查约 9 秒，完整合成音视频测试约 80 秒；后者保留中断边界片段并实际解码，不只检查恢复后的画面：

```sh
node --test --test-concurrency=1 scripts/media-encoder-lifecycle.test.cjs scripts/session-media-outage.test.cjs
```

生命周期测试用 Node 预加载器将编码器替换为模拟进程，仍使用真实的系统管道；不会改变临时目录禁止执行的挂载属性。完整音视频测试使用实际 FFmpeg 和 go2rtc。

首段录像测试约 35 秒，模拟两个消费者在不同关键帧阶段加入已运行的流。首段与结束片段都检查轨道起点、时长、帧密度及完整解码。可通过环境变量选择与实际 Frigate 相同的录像和解码二进制；桥接编码仍使用 PATH 中的 FFmpeg：

```sh
RECORDER_FFMPEG_BIN=/path/to/frigate/ffmpeg node --test scripts/rtsp-startup.test.cjs
RECORDER_FFMPEG_BIN=/path/to/frigate/ffmpeg node --test scripts/session-media-outage.test.cjs
```

开发回归中，`TEST_OLD_GOP=1` 可让首段测试使用旧的两秒关键帧间隔作失败对照，不改变生产默认值。已比较 FFmpeg 7 与实际 Frigate 携带的 FFmpeg 8；不能仅凭容器中存在某版本就认定录像进程使用它，应核对实际进程。
