{{/* Common labels applied to chart-managed objects. */}}
{{- define "helix-otel-operator.labels" -}}
app.kubernetes.io/managed-by: helix-configurator
app.kubernetes.io/part-of: helix-otel
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Selector that matches the Operator-managed collector pods for the alias Service.
     The OTel Operator labels collector pods with these keys; instance is <ns>.<cr-name>. */}}
{{- define "helix-otel-operator.collectorSelector" -}}
app.kubernetes.io/component: opentelemetry-collector
app.kubernetes.io/instance: {{ .Release.Namespace }}.{{ .Values.gateway.name }}
{{- end -}}
