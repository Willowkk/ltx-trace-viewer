# LTX 推理时间线 · uPlot 预览

`preview/uplot` 分支用 uPlot 和 Canvas 绘制四张资源曲线，第五张图显示 LTX 各阶段的起止时间。五张图共享游标，可在同一时刻对照 CPU/GPU、内存、存储和 PCIe 读数。页面用 TypeScript 与 Vite 构建，导入的文件在本机浏览器内解析。

公开示例的资源读数由程序生成，页面标为「模拟示例」。可以把同一次真实采集分别导入本分支和线上主版本，直接对照拖动体验。[打开 main 分支网页](https://willowkk.github.io/ltx-trace-viewer/)

## 使用

- 将单个 JSON 或 gzip 压缩的 JSON 拖入页面，也可点击「导入文件」选择文件。
- 在图表卡片内移动鼠标，五张图同步跟随同一个时间游标。经过标题、图例或两图之间的空白时也能连续查看。采样读数面板展示游标所在阶段、最近的实际采样时间和八项读数。移出卡片时保留最后一次读数。键盘聚焦资源图后，可用左右方向键逐点查看，Home / End 跳到窗口边界。
- 点击顶部阶段带、使用「分阶段」选择器，或点击底部时间线中的阶段，局部视图以该阶段的起止时间重新绘制图表。点击「全程总览」恢复。也可以在顶部阶段带按住并拖动，直接沿整次采集定位。阶段区间包含起点，止于终点之前。缺测显示为「—」。
- 页面「格式说明」提供可直接下载、重新导入的完整示例。

## 数据格式

### Chrome Trace

支持顶层事件数组与含 `traceEvents` 数组的对象。资源使用 Counter 事件（`ph: "C"`），八个 LTX 阶段使用完整区间事件（`ph: "X"`）。`ts` 和 `dur` 均以微秒计。相同时间戳的各项读数对齐在同一行。

```json
{
  "traceEvents": [
    {"ph":"X","name":"prompt.encode","ts":1000000,"dur":400000,"pid":1,"tid":1},
    {"ph":"C","name":"resources","ts":1100000,"pid":2,"args":{"cpu_pct":23,"gpu_pct":18,"rss_gib":2.3,"pcie_rx_mib_s":512}}
  ]
}
```

采集起点为零的相对时钟直接使用。对很大的绝对时间戳（≥ 10¹² 微秒），默认以最早的有效计时事件为零点；可在顶层显式提供 `timeOriginUs` 指定采集起点。程序识别常见计数器名称与显式单位。自定义字段、多个设备同名字段可使用「匹配指标字段」手动选择计数器轨道、字段及单位。累计字节字段需要选择「累计字节」，速率按相邻时间与计数的差计算，首点和计数器重置点显示为缺测。

### 完整采集 CSV

在「导入文件」中同时选择同一次采集的 `resources.csv` 与 `phases.csv`，也可加入 `manifest.json` 读取总时长。文件也可以一起拖入页面。`resources.csv` 使用 `elapsed_s` 作横坐标，`phases.csv` 使用 `name`、`start_s` 与 `duration_s` 标注阶段。含 `cpu_cores` 的资源表会提示确认当次分配核数，再计算进程 CPU 百分比。精简的 Chrome 导出可能只含部分计数器；顶部会显示实际指标数量，缺失项保留为空。

### 通用 JSON

```json
{
  "samples": [
    {"time": 0.0, "cpu": 12, "gpu": 0, "rss": 1.2, "vram": 0.5, "read": 18, "write": 0, "rx": 0, "tx": 0},
    {"time": 0.5, "cpu": 30, "gpu": 45, "rss": 2.1, "vram": 1.3, "read": 11, "write": 0, "rx": 520, "tx": null}
  ],
  "stages": [{"id": "prompt.encode", "start": 0.1, "end": 0.65}],
  "duration": 0.8
}
```

| 字段 | 含义 |
| --- | --- |
| `time`, `start`, `end`, `duration` | 距采集启动的秒数或以秒表示的时长 |
| `cpu`, `gpu` | 利用率（0–100），CPU 按分配核数归一化 |
| `rss`, `vram` | 进程 RSS 与设备已用显存，GiB |
| `read`, `write` | 进程存储读写速率，MiB/s |
| `rx`, `tx` | 设备 PCIe 接收与发送速率，MiB/s |

文件至少需要一个有读数的采样点。字段缺失或为 `null` 表示缺测。采样时间可以不均匀。阶段支持自定义 `id` 和 `name`，也可用 `duration` 代替阶段的 `end`。若省略顶层 `duration`，总览截止到最后一个阶段或采样点。单次执行应使用本次实际阶段。对只有资源数据、且时间与参考采集对齐的文件，可以点击「套用参考八阶段」或设置 `"stagePreset": "ltx-reference"`。

内置的八个阶段为 `runtime.import_torch`、`runtime.import_pipeline`、`prompt.encode`、`diffusion.1`、`video.spatial_upsample`、`diffusion.2`、`video.decode`、`audio.decode`。

## 运行预览分支

使用 Node.js 22.19 或更高版本。在仓库目录执行以下命令，打开终端显示的本地地址。

```sh
git switch preview/uplot
npm ci
npm run dev
```

在生产构建上检查效果可运行 `npm run build` 和 `npm run preview`。运行 `npm test` 检查解析、字段映射和游标事件。本机装有 Chrome 时，`npm run test:browser` 会构建并启动网页，检查五图联动等交互。

### 导出可离线双击的 HTML

先运行一次 `npm run build`，再使用以下命令之一。输出的单个 HTML 包含页面、图表库和样式，双击即可查看，也可在离线页面中继续导入其他采集。

```sh
# 使用公开的模拟数据
node scripts/standalone.mjs --output dist/ltx-preview.html

# 打开时直接显示指定的本地采集
node scripts/standalone.mjs --output dist/my-capture.html --capture "/path/to/capture.json"
```

`--capture` 接受通用 JSON 或可自动识别资源计数器的 Chrome Trace JSON。生成的 HTML 包含所选 JSON 的全部内容，分享该文件也会分享这次采集。默认输出目录 `dist/` 已加入 Git 忽略规则。
