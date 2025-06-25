import express from 'express'
import { createHttpTerminator } from 'http-terminator'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/express/v4'
import preset from './graphile.config.ts'

const app = express()

const pgl = postgraphile(preset)
const pglServ = pgl.createServ(grafserv)
const srv = app.listen(5678, () => {
	console.log('Server is running on http://localhost:5678')
})

const terminator = createHttpTerminator({
	server: srv,
	gracefulTerminationTimeout: 1_500
})

pglServ.addTo(app, srv)

process.once('SIGINT', async() => {
	await pglServ.release()
	console.log('PostGraphile server released')

	await terminator.terminate()
	console.log('Server closed')

	process.exit(0)
})
