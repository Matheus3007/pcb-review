# rebot-ctrl-v2 — checks PASS

0 errors · 0 warnings · 40 waived  
board 25.05 × 25.05 mm · 57 footprints · 491 track segments · 96 vias · 591.83 mm copper

## circuit
- ✓ `circuit/assertion` Buck Vin: spike budget vs LMR36506 65 V: 40 V in [0, 58.5]
- ✓ `circuit/assertion` Buck output (RFBT 100k / RFBB 22k): 5.545 V in [5.3, 5.8]
- ✓ `circuit/assertion` +5V rail after the OR diode (receiver supply): 5.195 V in [4.75, 5.5]
- ✓ `circuit/assertion` +5V vs XC6206 6.0 V max input: 5.545 V in [0, 6]
- ✓ `circuit/assertion` XC6206 headroom (dropout ~0.25 V @ 100 mA): 1.895 V in [0.4, 3]
- … 8 more `circuit/assertionok`

## schematic
- ✓ `schematic/pins_match` all 191 symbol pins match parts.yaml
- ✓ `schematic/netlist_match` KiCad's netlist of the schematic equals circuit.py (43 nets)

## erc
- ! `erc/pin_to_pin` Pins of type Bidirectional and Power output are connected: Symbol U4 Pin 2 [SDX, Bidirectional, Line]; Symbol #FLG02 Pin 1 [Power output, Line] _(waived: LSM6DSV32X DS13511 table 2: SDx must be tied to VDD_IO or GND when the analog hub/Qvar is unused; tied to GND)_
- ! `erc/pin_to_pin` Pins of type Bidirectional and Power output are connected: Symbol U5 Pin 3 [~{WP}/IO_{2}, Bidirectional, Line]; Symbol U3 Pin 2 [VO, Power output, Line] _(waived: W25Q128JV: /WP tied high for standard (non-quad) SPI, as the datasheet requires; IO2 is never driven)_
- ! `erc/pin_to_pin` Pins of type Bidirectional and Power output are connected: Symbol U5 Pin 7 [~{HOLD}/~{RESET}/IO_{3}, Bidirectional, Line]; Symbol U3 Pin 2 [VO, Power output, Line] _(waived: W25Q128JV: /HOLD tied high for standard (non-quad) SPI, as the datasheet requires; IO3 is never driven)_

## drc
- ! `drc/silk_edge_clearance` Silkscreen clipped by board edge (board setup constraints silk clearance 0.1500 mm; actual 0.0000 mm): Polygon on Edge.Cuts; Segment of J3 on F.Silkscreen _(waived: USB-C footprint silk outline intentionally reaches the board edge (connector overhang marker, as in pipeline-demo); clipped by fab)_
- ! `drc/silk_edge_clearance` Silkscreen clipped by board edge (board setup constraints silk clearance 0.1500 mm; actual 0.0000 mm): Polygon on Edge.Cuts; Segment of J3 on F.Silkscreen _(waived: USB-C footprint silk outline intentionally reaches the board edge (connector overhang marker, as in pipeline-demo); clipped by fab)_

## parity
- ✓ `parity/ok` board matches the schematic (KiCad schematic parity)

## placement
- ✓ `placement/near` C10 -> U1 pad 1: 1.96 mm (max 2.5) — MCU VDD (pin 1) decoupling
- ✓ `placement/near` C11 -> U1 pad 17: 1.91 mm (max 2.3) — MCU VDD (pin 17) decoupling
- ✓ `placement/near` C15 -> U1 pad 15: 1.21 mm (max 2.2) — VDDA HF decoupling
- ✓ `placement/near` R14 -> U1 pad 9: 1.31 mm (max 1.9) — CURR divider at PA4
- ✓ `placement/near` C17 -> U1 pad 9: 2.35 mm (max 2.9) — CURR filter at PA4
- ✓ `placement/on_edge` J1 courtyard -0.18 mm from top edge — ESC cable plugs in from the top edge
- ✓ `placement/on_edge` J3 courtyard -0.52 mm from top edge — USB-C mouth at the top edge (reachable with the lid off)
- ✓ `placement/on_edge` J2 courtyard -0.17 mm from left edge — receiver cable comes from the robot left side
- … 16 more `placement/nearok`

## assembly
- · `assembly/board_size` board 25.05x25.05 mm below standard PCBA minimum 70x70 mm: JLC adds edge rails itself (order option 'Edge Rails/Fiducials: Added by JLCPCB')

## parts
- · `parts/tiers` 22 unique parts: basic 13, preferred 1, extended 8 (extended: C160407 SM08B-SRSS-TB(LF)(SN), C189895 SM04B-GHS-TB(LF)(SN), C165948 TYPE-C-31-M-12, C2870127 LMR36506RRPER, C167761 FNR3015S220MT, C529358 STM32G431KBU6, C22461202 LSM6DSV32XTR, C24733358 GD25Q128EWIGY)

## current
- ✓ `current/width` GND: min track 0.15 mm vs 0.115 mm needed for 0.5 A (IPC-2221, ΔT 10 °C, 1.0 oz)
- ✓ `current/width` VBAT: min track 0.4 mm vs 0.115 mm needed for 0.5 A (IPC-2221, ΔT 10 °C, 1.0 oz)
- ✓ `current/width` +5V: min track 0.3 mm vs 0.115 mm needed for 0.5 A (IPC-2221, ΔT 10 °C, 1.0 oz)
- ✓ `current/width` VBUS: min track 0.2 mm vs 0.115 mm needed for 0.5 A (IPC-2221, ΔT 10 °C, 1.0 oz)
- ✓ `current/width` BUCK_SW: min track 0.4 mm vs 0.115 mm needed for 0.5 A (IPC-2221, ΔT 10 °C, 1.0 oz)
- … 2 more `current/widthok`

## routing
- ! `routing/jog` +5V on F.Cu: 0.42 mm sideways step at (18.38, 23.90) (board coords, +Y down); straighten it (REROUTE=1, placement, or a scripted track) _(waived: +5V distribution (buck/USB -> LDO, receiver), DC with bulk caps at both ends)_
- ! `routing/jog` +5V on In2.Cu: 0.89 mm sideways step at (8.96, 15.02) (board coords, +Y down); straighten it (REROUTE=1, placement, or a scripted track) _(waived: +5V distribution (buck/USB -> LDO, receiver), DC with bulk caps at both ends)_
- ! `routing/jog` +5V on In2.Cu: 1.45 mm sideways step at (13.11, 15.64) (board coords, +Y down); straighten it (REROUTE=1, placement, or a scripted track) _(waived: +5V distribution (buck/USB -> LDO, receiver), DC with bulk caps at both ends)_
- ! `routing/jog` 3V3 on F.Cu: 0.48 mm sideways step at (3.68, 16.27) (board coords, +Y down); straighten it (REROUTE=1, placement, or a scripted track) _(waived: 3V3 distribution, DC and decoupled at every pin)_
- ! `routing/jog` 3V3 on F.Cu: 0.85 mm sideways step at (9.40, 9.50) (board coords, +Y down); straighten it (REROUTE=1, placement, or a scripted track) _(waived: 3V3 distribution, DC and decoupled at every pin)_
- · `routing/stats` 304 bends total; per net: +5V 17, 3V3 44, BOOT0 4, BUCK_BOOT 8, BUCK_FB 6, BUCK_SW 6, BUCK_VCC 19, CC1 7, CC2 3, CRSF_IN 3, CRSF_OUT 3, CRSF_RX 1, CRSF_TX 1, CURR_ADC 3, DSHOT1 2, DSHOT2 2, DSHOT3 2, DSHOT4 2, ESC_CURR 1, ESC_TLM 1, FLASH_CS 4, GND 3, IMU_CS 6, IMU_INT1 7, LED 1, LED_A 2, M1 1, M2 1, M4 1, NRST 4, SPI_MISO 17, SPI_MOSI 13, SPI_SCK 14, SWCLK 10, SWDIO 13, TLM_RX 16, USB_DM 10, USB_DP 10, V5_BUCK 8, VBAT 21, VBAT_ADC 4, VBUS 3
- … 30 more `routing/jogwarningw`

## layout
- ✓ `layout/return_path` every signal track has unbroken GND on its reference layer
- ✓ `layout/finger` no unstitched dead-end GND tongues longer than 8.0 mm
- ✓ `layout/loop` buck HF input loop (C2): 1.67 mm² enclosed by C2.1 → U2.4 → U2.9 → C2.2 (max 3.0 mm²)
- ✓ `layout/loop` buck HF input loop (C2): U2.9 and C2.2 (GND) are not joined by copper on F.Cu; nearest GND vias 1.07 / 0.71 mm from them (max 1.5 mm, so the return drops straight into the plane)
- ✓ `layout/loop` buck bulk input loop (C1): 3.86 mm² enclosed by C1.1 → U2.4 → U2.9 → C1.2 (max 6.0 mm²)
- ✓ `layout/pair` USB_DP/USB_DM: lengths 34.34/38.61 mm, skew 4.27 mm (max 5.0)
