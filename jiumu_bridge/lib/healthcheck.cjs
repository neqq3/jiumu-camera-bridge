// SPDX-License-Identifier: Apache-2.0
'use strict';
// Probe real go2rtc readiness via the private loopback endpoint. No credentials,
// camera connection, vendor request or media data are needed for this check.
const http=require('node:http');
const deadline=setTimeout(()=>process.exit(1),3000);
const request=http.get({hostname:'127.0.0.1',port:Number(process.env.MEDIA_PORT||18083),path:'/ready'},response=>{
  response.resume();
  clearTimeout(deadline);
  process.exit(response.statusCode===200?0:1);
});
request.on('error',()=>{clearTimeout(deadline);process.exit(1);});
