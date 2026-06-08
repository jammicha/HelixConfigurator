{{/* Common labels applied to every object. */}}
{{- define "helix-otel.labels" -}}
app.kubernetes.io/managed-by: helix-configurator
app.kubernetes.io/part-of: helix-otel
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Gateway selector labels. */}}
{{- define "helix-otel.gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.gateway.name }}
app.kubernetes.io/component: gateway
{{- end -}}
