import express from 'express'
import { postgraphile } from 'postgraphile'
import { grafserv } from 'postgraphile/grafserv/express/v4'
import preset from './graphile.config.ts'

const app = express()

const pgl = postgraphile(preset)
const srv = pgl.createServ(grafserv)
srv.addTo(app, null)

app.listen(5678, () => {
	console.log('Server is running on http://localhost:5678')
})