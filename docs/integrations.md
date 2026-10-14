<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 接入 Frigate 和 Home Assistant

桥接输出标准 RTSP。Frigate 负责检测和录像；HA 通过 Generic Camera 看画面，或通过现有 Frigate 集成获取检测事件、录像和相关实体。HAOS 加载项解决服务安装问题，HA 集成解决实体接入问题，两者不相互替代。

## Frigate

优先使用桥接网页生成的配置，合并到现有 `go2rtc.streams` 与 `cameras`。不要覆盖整份 Frigate 配置。摄像头名称和密码由本地桥接生成，示例只展示结构：

```yaml
go2rtc:
  streams:
    my_camera:
      - "rtsp://viewer:REPLACE_WITH_LOCAL_RTSP_PASSWORD@BRIDGE_HOST:RTSP_PORT/CAMERA_STREAM_ID"
cameras:
  my_camera:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/my_camera
          input_args: [-rtsp_transport, tcp, -timeout, "10000000", -use_wallclock_as_timestamps, "1"]
          roles: [detect]
        - path: rtsp://127.0.0.1:8554/my_camera
          input_args: [-rtsp_transport, tcp, -timeout, "10000000", -use_wallclock_as_timestamps, "1"]
          roles: [record]
      output_args:
        record: ["-f", "segment", "-segment_time", "10", "-segment_format", "mp4", "-reset_timestamps", "1", "-strftime", "1", "-c", "copy", "-copytb", "1", "-bsf:v", "noise=amount=0:drop=eq(pts\\,nopts)"]
    detect:
      width: 640
      height: 480
      fps: 5
    record:
      enabled: true
```

分辨率和音轨示例对应本次测试的 A907-J；不同设备需重新验证。检测器、对象、人脸、MQTT、录像保留规则沿用你自己的设置。参考 [Frigate Restream](https://docs.frigate.video/configuration/restream/)。

输入参数经过 FFmpeg 7 合成测试及 Frigate 0.18 的实际 FFmpeg 8 录像检查：检测和录像输入使用接收时间，避免上游编码器重启后 RTP 时间戳跳变导致重复帧突增。合成测试覆盖同一 RTSP 连接上的多次上游重启；这项修复不代表摄像头本身断流已经解决。音频和视频编码器可分别重启，原 RTP 时间戳会使录像音轨起点出现数小时偏移。录像也使用接收时间以约束偏移；因此视频轨是可变帧率，分段时长取决于实际到达的关键帧，不保证每段恰好 10 秒。两个输入均由本地 restream 分发。其他版本需验证 `-timeout` 支持及录像时间。

## Home Assistant

只看画面：添加 [Generic Camera](https://www.home-assistant.io/integrations/generic/)，Stream Source 填桥接生成的 RTSP URL，使用 TCP。这里使用本地取流凭据，不使用九目账号。

需要检测与录像：先让 Frigate 获取画面，再安装 [Frigate HA 集成](https://docs.frigate.video/integrations/home-assistant/)，按照该集成文档配置双方共用 MQTT。尚未在本项目测试环境验证 HA 实体创建。

录像参数保留解复用器的时钟精度，并丢弃恢复时偶尔出现的无时间戳视频包；不会重新编码或修改保留的数据包。请同时更新桥接版本和本摄像头的录像参数。中断仍会留下缺帧，不能把跨越中断的片段时长当作连续画面。
