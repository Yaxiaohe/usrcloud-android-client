package org.usrcloud.xunjian;

/** 账号配置，对应 accounts.csv 的一行。 */
public class Account {
    public String name = "";
    public String account = "";
    public String password = "";
    public String platformId = "W3rfV";
    public boolean enabled = true;
    /** 站点过滤关键词；为空表示该账号全部设备。 */
    public String stationKw = "";

    public String[] keywords() {
        if (stationKw == null || stationKw.trim().isEmpty()) return new String[0];
        return stationKw.trim().split("[、，,;；\\s]+");
    }

    public boolean hasFilter() {
        return keywords().length > 0;
    }

    /** 站名是否被本站点的过滤词命中。巡站与历史页共用，避免两处口径不一致。
        空过滤 = 全部命中；站名为 null 一律不命中（与巡站原来的 d.name != null 一致）。 */
    public boolean matchesStation(String name) {
        if (name == null) return false;
        String[] kws = keywords();
        if (kws.length == 0) return true;
        for (String k : kws) {
            if (name.contains(k)) return true;
        }
        return false;
    }
}
