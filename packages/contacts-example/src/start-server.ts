import fastify from 'fastify'
import { createHttpTerminator } from 'http-terminator'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/fastify/v4'
import preset from './graphile.config.ts'

const app = fastify()

const pgl = postgraphile(preset)
const pglServ = pgl.createServ(grafserv)

const terminator = createHttpTerminator({
	server: app.server,
	gracefulTerminationTimeout: 1_500
})

pglServ.addTo(app)

await app.listen({ port: 5678 })
console.log('Server listening on http://localhost:5678')

process.once('SIGINT', async() => {
	await pglServ.release()
	console.log('PostGraphile server released')

	await terminator.terminate()
	console.log('Server closed')

	process.exit(0)
})
