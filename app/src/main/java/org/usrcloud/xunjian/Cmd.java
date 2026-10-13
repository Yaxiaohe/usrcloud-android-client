package org.usrcloud.xunjian;

/**
 * 【v0.31】命令下发的纯逻辑（零依赖，可脱离 Android 单测）。
 *
 * <p>为什么单独抽一个类：下发是本版风险最高的动作 ——
 * 请求体拼错、或者把平台的「已受理」当成「已写入」，都会让用户以为写成功了而实际没写。
 * 这类判断必须能用纯 JVM 跑真实代码验证（jcmdtest），而不是在真机上碰运气。
 *
 * <p>平台事实（已在本账号真机接口上逐条核对）：
 * <ul>
 *   <li>下发地址：先 POST
 *       {@code openapi.mp.usr.cn/usrCloud/V6/ucloudSdk/getCommandAddress}
 *       拿到 {@code commandServerAddr}（本账号返回 https://openhttp.usr.cn），
 *       再拼 {@code /v2.0/dataPoint/{设备号}}。apimp 那个域上没有这个路径（404）。
 *   <li>请求体：{@code {"setDataPoint":[{"dataPointId":<dataPointRelId>,"value":"<值>"}]}}
 *       —— dataPointId 取变量列表里的 dataPointRelId。两份官方文档都把它叫「变量id」
 *       （获取设备变量列表：dataPointRelId=变量id；命令下发：dataPointId=变量id），
 *       与 device→cloud 上报用的「数据点关联id」也是同一个值。
 *   <li>响应：{@code {"status":200,"info":"success"}}。**注意 status=200 只代表平台收下了**：
 *       发一个根本不存在的变量 id 也照样返回 success，所以只能判「已受理」，
 *       不能判「设备已改」。真正有没有写进去，得等设备回传后看数据。
 * </ul>
 */
public final class Cmd {

    private Cmd() {
    }

    /** JSON 字符串转义：值里可能有引号/反斜杠，直接拼会把请求体拼坏。 */
    static String esc(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    /** 拼下发请求体。value 一律按字符串下发（平台要 string）。 */
    public static String buildBody(long relId, String value) {
        return "{\"setDataPoint\":[{\"dataPointId\":" + relId
                + ",\"value\":\"" + esc(value) + "\"}]}";
    }

    /** 从响应体里抠出 status 数字；抠不到返回 Integer.MIN_VALUE。 */
    static int statusOf(String body) {
        if (body == null) return Integer.MIN_VALUE;
        int i = body.indexOf("\"status\"");
        if (i < 0) return Integer.MIN_VALUE;
        int j = body.indexOf(':', i + 8);
        if (j < 0) return Integer.MIN_VALUE;
        int k = j + 1;
        /* 兼容 "status":"0" 这种字符串形态 */
        while (k < body.length() && (body.charAt(k) == ' ' || body.charAt(k) == '"')) k++;
        int s = k;
        while (k < body.length()
                && (body.charAt(k) == '-' || Character.isDigit(body.charAt(k)))) k++;
        if (k == s) return Integer.MIN_VALUE;
        try {
            return Integer.parseInt(body.substring(s, k));
        } catch (Exception e) {
            return Integer.MIN_VALUE;
        }
    }

    /**
     * 平台是否「收下了」这条指令。
     *
     * <p>只认「HTTP 2xx + 没有明确的错误码」：
     * status 缺失（空响应体/非 JSON）时按 HTTP 码判；status=0 或 200 算受理；
     * 其它（1526 token 失效 / 5004 权限不足 / 5106 参数缺失 …）都算失败。
     */
    public static boolean isAccepted(int http, String body) {
        if (http < 200 || http >= 300) return false;
        int st = statusOf(body);
        if (st == Integer.MIN_VALUE) return true;
        return st == 0 || st == 200;
    }

    /** 失败时给人看的原因（成功返回空串）。 */
    public static String reason(int http, String body) {
        if (http < 200 || http >= 300) {
            return "平台返回 HTTP " + http
                    + (body == null || body.isEmpty() ? "" : "：" + oneLine(body));
        }
        int st = statusOf(body);
        if (st == Integer.MIN_VALUE) return "";
        /* 成功码必须返回空串。漏掉这一条的话，对成功响应调 reason()
           会得到「平台拒绝（0 ok）」这种自相矛盾的文案。 */
        if (st == 0 || st == 200) return "";
        if (st == 1526) return "登录已过期，请重试";
        if (st == 5004) return "当前账号没有下发权限";
        if (st == 5106) return "参数不完整";
        String info = infoOf(body);
        return "平台拒绝（" + st + (info.isEmpty() ? "" : " " + info) + "）";
    }

    /** 取响应里的 info 文本，用于报错。 */
    static String infoOf(String body) {
        if (body == null) return "";
        int i = body.indexOf("\"info\"");
        if (i < 0) return "";
        int j = body.indexOf('"', i + 6);
        if (j < 0) return "";
        int k = body.indexOf('"', j + 1);
        if (k < 0) return "";
        return body.substring(j + 1, k);
    }

    private static String oneLine(String s) {
        s = s.replace("\r", " ").replace("\n", " ").trim();
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }
}
