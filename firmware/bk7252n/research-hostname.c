// SPDX-License-Identifier: Apache-2.0
// The SDK fork's lwIP port expects this application-owned hostname callback.
const char *CFG_GetOpenBekenHostName(void)
{
    return "bk7252n-research";
}
