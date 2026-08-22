type MetricLabels = Record<string, string | number | boolean>;

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function metric(name: string, value: number, labels: MetricLabels = {}) {
  const renderedLabels = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, labelValue]) => `${key}="${escapeLabel(String(labelValue))}"`)
    .join(",");
  return `${name}${renderedLabels ? `{${renderedLabels}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

export function metricFamily(
  name: string,
  type: "counter" | "gauge" | "histogram",
  help: string,
  samples: string[],
) {
  return [`# HELP ${name} ${help.replace(/\n/g, " ")}`, `# TYPE ${name} ${type}`, ...samples];
}

export function prometheusDocument(families: string[][]) {
  return `${families.flat().join("\n")}\n`;
}

export function operationalLog(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  attributes: Record<string, unknown> = {},
) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...attributes,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else if (level === "debug") console.debug(entry);
  else console.info(entry);
}
