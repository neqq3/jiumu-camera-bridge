<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# 接入 Frigate 和 Home Assistant

桥接输出标准 RTSP。Frigate 负责检测和录像；HA 通过 Generic Camera 看画面，或通过现有 Frigate 集成获取检测事件、录像和相关实体。HAOS 加载项解决服务安装问题，HA 集成解决实体接入问题，两者不相互替代。

## Frigate

优先使用桥接网页生成的配置，合并到现有 `go2rtc.streams` 与 `cameras`。不要覆盖整份 Frigate 配置。摄像头名称和密码由本地桥接生成，示例只展示结构：

```yaml
go2rtc:
  streams:
    my_camera:
      - "rtsp://viewer:REPLACE_WITH_LOCAL_RTSP_PASSWORD@BRIDGE_HOST:18554/CAMERA_STREAM_ID"
cameras:
  my_camera:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/my_camera
          input_args: preset-rtsp-restream
          roles: [detect, record]
      output_args:
        record: preset-record-generic-audio-copy
    detect:
      width: 640
      height: 480
      fps: 5
    record:
      enabled: true
```

分辨率和音轨示例对应本次测试的 A907-J；不同设备需重新验证。检测器、对象、人脸、MQTT、录像保留规则沿用你自己的设置。参考 [Frigate Restream](https://docs.frigate.video/configuration/restream/)。

## Home Assistant

只看画面：添加 [Generic Camera](https://www.home-assistant.io/integrations/generic/)，Stream Source 填桥接生成的 RTSP URL，使用 TCP。这里使用本地取流凭据，不使用九目账号。

需要检测与录像：先让 Frigate 获取画面，再安装 [Frigate HA 集成](https://docs.frigate.video/integrations/home-assistant/)，按照该集成文档配置双方共用 MQTT。尚未在本项目测试环境验证 HA 实体创建。
