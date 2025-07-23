import { createServer } from 'http'
import { createHttpTerminator } from 'http-terminator'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/node'
import preset from './graphile.config.ts'

const PORT = +(process.env.PORT || 5678)

const srv = createServer()

const pgl = postgraphile(preset)
const pglServ = pgl.createServ(grafserv)

await pgl.getSchema()

await pglServ.addTo(srv)
await srv.listen({ port: PORT })

const terminator = createHttpTerminator({
	server: srv,
	gracefulTerminationTimeout: 1_500
})

console.log('Server listening on http://localhost:' + PORT)

process.once('SIGINT', async() => {
	await pglServ.release()
	console.log('PostGraphile server released')

	await terminator.terminate()
	console.log('Server closed')

	for(const srv of preset.pgServices || []) {
		await srv.release?.()
	}

	process.exit(0)
})
