import express from 'express'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/express/v4'
import preset from './graphile.config.ts'

const app = express()

const pgl = postgraphile(preset)
const pglServ = pgl.createServ(grafserv)
const srv = app.listen(5678, () => {
	console.log('Server is running on http://localhost:5678')
})

pglServ.addTo(app, srv)