// SPDX-License-Identifier: Apache-2.0
'use strict';
const messages=Object.freeze({
  account_input:'请填写九目智联账号和密码。',
  cloud_unreachable:'无法连接厂商服务，请检查桥接主机的外网连接后重试。',
  login_rejected:'厂商未接受登录，请核对账号、密码及账号状态。',
  cloud_response:'厂商返回的数据无法读取，请稍后重试。',
  device_list:'账号已登录，但设备列表获取失败，请稍后重新登录。',
  login_expired:'设备选择已过期，请重新登录获取列表。',
  selection:'请选择 1 至 4 台可接入的摄像头。',
  device_unavailable:'这台摄像头缺少有效连接信息，请在官方 APP 确认绑定后重新获取列表。',
  ip_hint:'摄像头 IP 必须是局域网 IPv4 地址；也可以留空自动发现。',
  export_host:'请填写运行桥接的主机局域网 IP 或主机名，不要填写完整网页 URL。',
  save_failed:'配置未能保存，请检查桥接数据目录的可写权限和剩余空间后重试。',
  request:'请求无效，请检查填写的内容后重试。'
});
class SetupError extends Error {
  constructor(code){super(messages[code]||messages.request);this.code=Object.hasOwn(messages,code)?code:'request';}
}
function setupResponse(error,fallback='request'){
  const code=error instanceof SetupError?error.code:Object.hasOwn(messages,fallback)?fallback:'request';
  return {code,error:messages[code]};
}
module.exports={SetupError,setupResponse};
