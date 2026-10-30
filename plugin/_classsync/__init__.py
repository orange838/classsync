"""ClassSync 内部模块包。

单独放一个包目录，避免污染 CW2 插件的全局 sys.path
（CW2 会把插件目录加入 sys.path，顶层模块名会跨插件抢占）。
"""
