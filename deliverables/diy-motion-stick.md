# DIY 开源体感棒指南 —— 「开源版 Joy-Con」给 WarmingUp 律动跑酷

> 目标：让没有 Joy-Con 的人也能用体感棒玩。核心原理：游戏的手柄/键盘输入源是**硬件抽象层**
> ——设备只要把自己"装成"标准蓝牙/USB 手柄或键盘，游戏即插即用、零改动。

## 一、方案对比（参考价已联网核对 2026-11-18，以实际为准）

| 方案 | 核心件 | 参考价 | DIY 难度 | 游戏接入 | 体感能力 |
|---|---|---|---|---|---|
| ① ESP32 + MPU6050 蓝牙棒 | ESP32-C3/S3 + MPU6050 | **≈￥65 全套** | 焊 4 根线 + 刷固件 | 蓝牙 HID 手柄 → Gamepad API 直认 | 6 轴全波形（挥/跳/蹲都可分档） |
| ② ESP32-S2/S3 有线棒 | 同上（省电池） | ≈￥40 | 同上 | **USB HID 插线直认**（免配对） | 同上 |
| ③ M5StickC Plus2 免焊棒 | 自带 IMU/屏/按键/腕带 | ≈￥100~180 | **零焊接**，只刷固件 | 蓝牙 HID 手柄 | 同上，还带震动/蜂鸣反馈 |
| ④ micro:bit 倾斜棒（教学向） | micro:bit V2 自带加速度计 | ≈￥108~120 | MakeCode 积木编程，**小学生能写** | 发方向键 → 键盘通道直认 | 只有倾斜/摇晃，判定粗但课堂氛围好 |
| ⑤ 手机 IMU（对照组） | 旧手机 | ￥0 | 无 | 已有传感器模式 | 中 |

**推荐**：教室批量 → ②有线棒（免蓝牙配对、插上就认、单价最低）；个人/客厅 → ①蓝牙棒；
编程社团课 → ④micro:bit（写代码本身就是教学内容）；不想动手 → ③M5StickC。

## 二、为什么即插即用（对接原理）

游戏第 18 轮的输入源设计：
- **手柄通道**：Gamepad API 标准映射（A跳 B踩 X挥 Y蹲 · L1/十字左=左 R1/十字右=右 · L2/R2=跑，摇杆上下=跳/踩、左右=移动）
- **键盘通道**：↑/W 跳 ↓/S 踩 ←/A 左 →/D 右 J 挥 K 蹲 L 跑

DIY 棒的固件只需要：读 IMU → 判定动作 → 按标准手柄按键（或键盘按键）"发"出去。
游戏不关心硬件是什么。多键位冗余 + 140ms 去重已内置，边沿触发不怕连发。

## 三、物料清单（方案①，实价 BOM）

| 元件 | 参考价 | 备注 |
|---|---|---|
| ESP32-C3-DevKit（或 ESP32-S3-Zero） | ¥20~30 | 自带蓝牙；S3 可走 USB HID |
| MPU6050 六轴模块 | ¥8~13 | I2C，四根线 |
| 3.7V 锂电池 500~1200mAh | ¥10~12 | 602030 薄块 |
| TP4056 充电保护板 | ¥1~3 | USB 充电 |
| 外壳（3D 打印/热缩管） | ¥0~10 | 网上有现成"体感棒"外壳模型 |
| **合计** | **≈￥45~65** | |

## 四、接线（就 4 根线，无额外元件）

```
ESP32-C3      MPU6050
------        ------
3V3     ────  VCC
GND     ────  GND
GPIO0   ────  SCL
GPIO1   ────  SDA
```

## 五、固件骨架（Arduino，基于开源库 ESP32-BLE-Gamepad + Adafruit MPU6050）

```cpp
// 开源版 Joy-Con 固件骨架 v0.1 —— 阈值需按手感实测调参
#include <BleGamepad.h>            // github.com/lemmingdev/ESP32-BLE-Gamepad
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

BleGamepad pad("WarmingUp 体感棒", "WarmingUp");
Adafruit_MPU6050 mpu;

// —— 动作判定阈值（按手感调）——
const float SWING_UP   = 14.0f;  // 上挥峰值(m/s^2)  → A 跳
const float SWING_DOWN = 14.0f;  // 下砸峰值        → B 踩
const float PUNCH_TH   = 16.0f;  // 前甩峰值        → X 挥臂
const float COOLDOWN   = 180;    // ms，动作去重

unsigned long tJump = 0, tStomp = 0, tPunch = 0;

void fire(int button, unsigned long &last) {
  if (millis() - last < COOLDOWN) return;
  last = millis();
  pad.press(button); delay(40); pad.release(button);
}

void setup() {
  Wire.begin(0, 1);
  mpu.begin();
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  pad.begin();
}

void loop() {
  if (!pad.isConnected()) return;
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);

  if (a.acceleration.y < -SWING_UP)   fire(BUTTON_1, tJump);   // 上挥 = 跳
  if (a.acceleration.y >  SWING_DOWN) fire(BUTTON_2, tStomp); // 下砸 = 踩
  if (a.acceleration.z < -PUNCH_TH)   fire(BUTTON_3, tPunch); // 前甩 = 挥臂

  // 摇杆 = 左右移动（把 x 轴倾角映射为 -127..127）
  int x = constrain((int)(a.acceleration.x * 10), -127, 127);
  pad.setAxes(x, 0, 0, 0, 0, 0, 0, 0);

  // 侧甩 = 左/右移（在 x 峰值上补按键更跟手）
  if (a.acceleration.x < -SWING_DOWN) fire(BUTTON_5, tStomp);
  if (a.acceleration.x >  SWING_DOWN) fire(BUTTON_6, tStomp);
  delay(8); // ~125Hz 采样
}
```

**烧录**：Arduino IDE → 装 ESP32 板卡 + 两个库 → 选 ESP32-C3 Dev Module → USB 烧录 →
电脑/手机蓝牙搜索「WarmingUp 体感棒」配对 → 游戏菜单第 2 步选手柄·键盘 → 开玩。

## 六、micro:bit 方案（教学向，MakeCode 积木）

逻辑（积木拖出来即可）：
- 「当倾斜 前/后 幅度 > 30°」→ 发送键盘 **↑（跳）/ ↓（踩）**
- 「当倾斜 左/右 幅度 > 30°」→ 发送键盘 **← / →（移动）**
- 「当按钮 A 被按」→ 发送 **J（挥臂）**；「摇晃 > 3g」→ 发送 **L（跑）**
- 用 MakeCode 的 **hidkeyboard 扩展**（USB 连接时即插即用；以官方扩展当前版本为准）

学生第一课：改阈值、改键位，马上在游戏里看到效果——硬件即教具。

## 七、边界（如实）

- 固件是**参考骨架，未经实机验证**（开发环境无硬件）；库版本、引脚以
  ESP32-BLE-Gamepad / Adafruit MPU6050 仓库当前文档为准；阈值必须上手调。
- 蓝牙 HID 在**智能电视自带浏览器**上支持弱（老边界）：教室/客厅优先②有线棒接小主机。
- 按键级判定 100% 准；「挥多大劲、蹲多深」的幅度分档需要把 IMU 原始波形发给游戏
  （自定义 WebSocket / WebHID 通道）——这是路线图「IMU 双路融合」的前置，点单可做。
