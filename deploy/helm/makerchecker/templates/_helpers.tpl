{{- define "makerchecker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "makerchecker.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "makerchecker.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "makerchecker.labels" -}}
helm.sh/chart: {{ include "makerchecker.chart" . }}
{{ include "makerchecker.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "makerchecker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "makerchecker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "makerchecker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "makerchecker.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "makerchecker.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret holding DATABASE_URL (and optional API keys). Either the
operator-supplied existingSecret, or one created by this chart.
*/}}
{{- define "makerchecker.secretName" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.existingSecret -}}
{{- else -}}
{{- printf "%s-env" (include "makerchecker.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "makerchecker.configMapName" -}}
{{- printf "%s-config" (include "makerchecker.fullname" .) -}}
{{- end -}}

{{- define "makerchecker.runtimeUrlKey" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.runtimeUrlKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end -}}

{{- define "makerchecker.ownerUrlKey" -}}
{{- if .Values.database.existingSecret -}}
{{- .Values.database.ownerUrlKey -}}
{{- else -}}
DATABASE_URL_OWNER
{{- end -}}
{{- end -}}

{{/*
Bundled-Postgres connection host:port. Only meaningful when postgresql.enabled.
*/}}
{{- define "makerchecker.bundledPostgresHost" -}}
{{- printf "%s-postgresql:%v" (include "makerchecker.fullname" .) .Values.postgresql.service.port -}}
{{- end -}}

{{/*
Resolve the owner DATABASE_URL when the chart creates the Secret. With bundled
Postgres it is derived; otherwise it falls back to database.ownerUrl.
*/}}
{{- define "makerchecker.resolvedOwnerUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $a := .Values.postgresql.auth -}}
{{- printf "postgres://%s:%s@%s/%s" $a.username $a.password (include "makerchecker.bundledPostgresHost" .) $a.database -}}
{{- else -}}
{{- .Values.database.ownerUrl -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the runtime DATABASE_URL when the chart creates the Secret. In hardened
mode with bundled Postgres it embeds the mc_app_runtime credential; otherwise it
falls back to database.runtimeUrl.
*/}}
{{- define "makerchecker.resolvedRuntimeUrl" -}}
{{- if and .Values.hardened.enabled .Values.postgresql.enabled -}}
{{- $a := .Values.postgresql.auth -}}
{{- printf "postgres://mc_app_runtime:%s@%s/%s" .Values.database.runtimePassword (include "makerchecker.bundledPostgresHost" .) $a.database -}}
{{- else if .Values.postgresql.enabled -}}
{{- include "makerchecker.resolvedOwnerUrl" . -}}
{{- else -}}
{{- .Values.database.runtimeUrl -}}
{{- end -}}
{{- end -}}
