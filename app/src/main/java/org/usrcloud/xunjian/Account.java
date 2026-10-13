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
}
