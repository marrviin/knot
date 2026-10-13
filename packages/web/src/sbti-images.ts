/** SBTI 卡片图索引：SbtiType.id → 打包后的资源 URL。import.meta.glob 一次性
 *  eager 引入 27 张 png（约 19MB，vite 发独立 hash 文件，首次展示对应卡片时才下载）。 */
const modules = import.meta.glob<string>("./assets/sbti-png/*.png", {
  eager: true,
  import: "default",
});

/** id → URL（文件名即 SbtiType.id）。 */
export const SBTI_IMAGES: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [
    path.replace(/^.*\/sbti-png\//, "").replace(/\.png$/, ""),
    url,
  ]),
);
