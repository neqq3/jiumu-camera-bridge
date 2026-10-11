<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 贡献

请在 PR 中说明变更目的、测试设备 / 固件版本、验证方式和尚未验证之处。贡献代码适用 Apache-2.0，原创文档正文适用 CC BY 4.0，范围以 LICENSE 为准；提交者须有权贡献材料。

不要提交厂商二进制、反编译源码或未知许可的复制代码。引用第三方实现时先标明来源及许可证。研究结论需区分静态推断、实际通信、真实媒体解码。

不要提交账号、设备 ID、MAC、Wi-Fi 名称 / 密码、云 token、真实 RTSP URL、抓包、录像或 APP 缓存。请使用明显虚构的示例和人工构造的测试数据。

检查 JavaScript 语法与文档本地链接：

```sh
node scripts/check.cjs
```

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
