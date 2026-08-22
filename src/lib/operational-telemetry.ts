type MetricLabels = Record<string, string | number | boolean>;

type OperationalCounter = {
  name: string;
  help: string;
  labels: MetricLabels;
  value: number;
};

const telemetryGlobal = globalThis as typeof globalThis & {
  __scenelithOperationalCounters?: Map<string, OperationalCounter>;
};
const counters = telemetryGlobal.__scenelithOperationalCounters || new Map<string, OperationalCounter>();
telemetryGlobal.__scenelithOperationalCounters = counters;

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

export function incrementOperationalCounter(
  name: string,
  help: string,
  labels: MetricLabels = {},
  amount = 1,
) {
  if (!/^scenelith_[a-z0-9_]+_total$/.test(name)) throw new Error(`Invalid operational counter: ${name}`);
  const sortedLabels = Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
  const key = `${name}:${JSON.stringify(sortedLabels)}`;
  const current = counters.get(key);
  if (current) current.value += amount;
  else counters.set(key, { name, help, labels: sortedLabels, value: amount });
}

export function operationalCountersPrometheus() {
  const grouped = new Map<string, OperationalCounter[]>();
  for (const counter of counters.values()) {
    const group = grouped.get(counter.name) || [];
    group.push(counter);
    grouped.set(counter.name, group);
  }
  return prometheusDocument([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) =>
    metricFamily(name, "counter", values[0].help, values.map((counter) => metric(name, counter.value, counter.labels))),
  ));
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
