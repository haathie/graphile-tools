import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { NodeSDK } from '@opentelemetry/sdk-node'

export const otelSdk = new NodeSDK({
	serviceName: 'postgraphile-contacts',
	traceExporter: new OTLPTraceExporter(),
	instrumentations: [
		new HttpInstrumentation(),
		new PgInstrumentation()
	],
})

otelSdk.start()