# SRT2mp3_by_Vits_Simple_api

用vits simple api 来给srt字幕文件生成音频的node.js脚本

将srt字幕文件放入脚本同目录下的srt目录，音频会生成到out目录
生成的音频会自动拼接，中间保留间隔时间，做到可以直接拖到pr项目对齐字幕
内置不太好用的颜文字过滤和词典过滤

[使用的vits项目](https://github.com/Artrajz/vits-simple-api)
因为这个程序只是发起http请求获取音频然后处理，所以其他的tts项目也完全通用（应该，改一改就好了
需要ffmpeg，其他依赖库在package.json，使用`npm install`即可安装依赖

该项目使用gemini pro 2.5辅助完成（我就做了发问和修改调试的部分（ai太好用了你知道吗反正能跑就行