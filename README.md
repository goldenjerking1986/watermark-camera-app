# 水印拍照上传

手机端实时拍照并自动叠加水印（拍摄时间、文件夹名称、备注），上传到服务端后按文件夹归集管理：后台可按文件夹浏览、预览、下载、删除照片。

## 功能

- **手机拍照端**：新建/管理资料文件夹，调用后置摄像头实时拍摄（也支持从相册选择），拍照时自动将拍摄时间、文件夹名称、备注压入照片水印
- **后台管理端**：按文件夹检索照片，缩略图预览，单张下载 / 整文件夹打包下载 / 删除
- 移动端优先设计，同时适配桌面端，跟随系统深浅色模式

## 技术栈

- 前端：React + TypeScript（`client/`）
- 服务端：TypeScript Server Actions + SQLite（`server/`，Drizzle ORM，迁移文件在 `drizzle/`）
- 包管理：bun

## 本地运行

```bash
bun install
bun run dev
```

## 目录结构

```
client/    # React 前端
server/    # 服务端 actions 与数据 schema
drizzle/   # 数据库迁移
```
