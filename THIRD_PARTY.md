# Third-party content

The code in this repository is MIT (see LICENSE). The published bundles (`bundles/`) also contain converted third-party data:

| Files | Source | License |
|---|---|---|
| `bundles/*/models/*.glb`, `bundles/_models/*.glb`, except the three below | KiCad 10 3D library (STEP → GLB) | CC-BY-SA 4.0 with the KiCad libraries exception |
| `HRO_TYPE-C-31-M-12_C165948.glb`, `LMR36506RRPER_C2870127.glb`, `HSBB6066_C2828498.glb` | LCSC/EasyEDA models via easyeda2kicad (through pcb-lab's `lib/3d`) | EasyEDA/LCSC terms (unclear). For box-only 3D, export with `ARGS=--no-models` |

**Datasheets are not hosted here.** The site embeds LCSC's (or JLC's) own copy of each PDF, loaded straight from their servers.

At run time the web app also uses pdf.js (Apache-2.0) and three.js (MIT), bundled from npm.
