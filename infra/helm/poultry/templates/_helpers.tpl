{{- define "poultry.name" -}}{{ .Release.Name }}{{- end }}

{{- define "poultry.labels" -}}
app.kubernetes.io/name: poultry
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "poultry.selector" -}}
app.kubernetes.io/name: poultry
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}
