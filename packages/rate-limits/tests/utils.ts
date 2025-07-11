import { createServer } from 'http'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/node'
import { type ExecutionResult, GraphQLError, GraphQLSchema } from 'postgraphile/graphql'

export type TestGraphileConfig = {
	ddl: string
	preset: GraphileConfig.Preset
}

export type BootedGraphileServer = {
	schema: GraphQLSchema
	graphqlRequest: <T>(request: GraphQLRequest) => Promise<T>
	close: () => Promise<void>
}

export type GraphQLRequest = {
	query: string
	headers?: Record<string, string>
	variables?: Record<string, any>
}

export async function runDdlAndBoot({ ddl, preset }: TestGraphileConfig) {
	const pool = preset.pgServices?.[0]?.adaptorSettings?.superuserPool
	if(!pool) {
		throw new Error('No superuser pool found in preset')
	}

	await pool.query(`BEGIN;\n${ddl}\nCOMMIT;`)

	return bootPreset(preset, 1234)
}

async function bootPreset(
	preset: GraphileConfig.Preset,
	port: number
): Promise<BootedGraphileServer> {
	const pgl = postgraphile(preset)
	const pglServ = pgl.createServ(grafserv)

	const srv = createServer()

	pglServ.addTo(srv)

	await new Promise<void>((resolve, reject) => {
		srv.listen(port, resolve)
		srv.once('error', reject)
	})

	console.log(`Server listening on http://localhost:${port}`)

	return {
		schema: await pglServ.getSchema(),
		graphqlRequest(req) {
			return graphqlRequest(`http://localhost:${port}/graphql`, req)
		},
		close
	}

	async function close() {
		await new Promise<void>((resolve, reject) => {
			srv.close(err => {
				if(err) {
					reject(err)
				} else {
					console.log('Server closed')
					resolve()
				}
			})
		})

		await pglServ.release()
	}
}

async function graphqlRequest<T>(
	url: string,
	{ headers, ...gqlReq }: GraphQLRequest
) {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...headers
		},
		body: JSON.stringify(gqlReq)
	})

	if(!response.ok) {
		if(response.headers.get('content-type')?.includes('application/json')) {
			const json = await response.json()
			throw new GraphQLError(
				`GraphQL request failed: ${response.status}`,
				{
					extensions: {
						body: json,
						statusCode: response.status,
						headers: Object.fromEntries(response.headers.entries())
					}
				}
			)
		}

		throw new Error(`GraphQL request failed: ${response.status}`)
	}

	const json = await response.json() as ExecutionResult<T>
	if(json.errors?.length) {
		const err = json.errors[0]
		throw new GraphQLError(err.message, err)
	}

	if(!json.data) {
		throw new Error('No data returned from GraphQL request')
	}

	return json.data
}