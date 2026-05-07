// 信源配置 — 直接 import JSON 让 worker bundle 自带配置
// 改信源后重新 deploy 即可生效

import sourcesJson from "../config/sources.json";
import type { SourcesConfig } from "./types";

export const SOURCES_CONFIG = sourcesJson as SourcesConfig;
