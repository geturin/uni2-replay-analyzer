# UNI2 Replay Analyzer

浏览器内解析 UNI2 的 REP-DATA，查看对局战绩、逐回合比分、翻盘与逆转、Perfect、开局 EXS 和对战资料。

线上使用：[uni.kero.zone](https://uni.kero.zone/)

## 本地运行

无需安装前端依赖。在本目录运行：

```sh
python -m http.server 4173 --bind 127.0.0.1
```

打开 `http://localhost:4173/` 并选择 REP-DATA，或点击页面上的演示按钮。

## 数据范围

录像在浏览器内解析；公开 Steam ID 用于查询当前昵称。末局结束方式缺失时显示“未记录”。EXS 是各回合开局值，暂不提供对局过程中 EXS、HP 的连续变化。

本仓库仅包含网页源码、静态资源和使用说明。
