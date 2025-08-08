import { check } from 'k6'
import { WebSocket } from 'k6/experimental/websockets'
import http from 'k6/http'
import { setTimeout } from 'k6/timers'

const GRAPH_QL_URL = 'http://localhost:5678/graphql'
const GRAPH_QL_WS_URL = 'ws://localhost:5678/graphql'

const UPSERT_CONTACTS_GQL = `
mutation ContactsCreate($items: [ContactsCreateItem!]!) {
  createContacts(
    items: $items, onConflict: Error
  ) {
    items {
      updatedAt
			type
			orgId
			contactTags {
				nodes {
					tag {
						rowId
						name
						createdBy
						createdAt
					}
					createdAt
					createdBy
				}
			}
			rowId
			platformNames
			name
			phoneNumber
			assignee
			assignedBy
			assignedAt
    }
  }
}
`

const SUB_QL = `subscription ContactsCreated($orgId: String!) {
	contactsCreated(condition: { orgId: $orgId }) {
		eventId
		items {
			rowId
			name
			phoneNumber
			createdAt
			orgId
		}
	}
}`

const MAX_SUB_DELAY_MS = 5_000

export const options = {
	'scenarios': {
		'constant_load': {
			'executor': 'constant-vus',
			'vus': 5000,
			'duration': '30s'
		}
	}
}

export default async function() {
	const orgId = `lt_tenant_${__VU}`
	const defaultOpts = {
		headers: {
			'content-type': 'application/json',
			'org-id': orgId,
			'user-id': 'load-test-user',
		}
	}

	let contactsCreated = 0
	let msgReceived = 0

	const ws = subscribe(
		{
			query: SUB_QL,
			variables: {
				orgId: orgId
			},
			headers: {
				'org-id': orgId,
				'user-id': 'load-test-user',
			}
		},
		msg => {
			const itemsRecv = msg?.payload?.data?.contactsCreated?.items
			if(typeof itemsRecv === 'undefined') {
				console.error('Received undefined items from subscription:', JSON.stringify(msg, null, 2))
				return
			}

			// console.log(`Received items: ${itemsRecv.length}`, itemsRecv.map(i => i.orgId))
			msgReceived += itemsRecv?.length || 0
			check(
				itemsRecv,
				{
					'sub has data': m => !!m?.length
				}
			)
		}
	)

	const isWsConnected = await conditionalTimeout(() => ws.connected)
	check(isWsConnected, {
		'ws connected': (v) => v === true
	})

	if(!ws.connected) {
		console.error('WebSocket connection failed')
		return
	}

	// wait for the subscription to be established
	await sleep(750)

	for(let i = 0;i < 1;i++) {
		const contact = createRandomContact()
		const singleRes = await http.asyncRequest(
			'POST',
			GRAPH_QL_URL,
			JSON.stringify({
				query: UPSERT_CONTACTS_GQL,
				variables: {
					items: [contact],
				}
			}),
			{ ...defaultOpts, tags: { requestId: 'createContact' } }
		)
		check(singleRes, { 'contact 200': (res) => res.status === 200 })
		contactsCreated += 1
	}

	await conditionalTimeout(() => msgReceived >= contactsCreated, MAX_SUB_DELAY_MS)

	ws.close()
	check(msgReceived, { 'data received on sub': v => v === contactsCreated })

	console.log('VU done, success: ', msgReceived, '=', contactsCreated)
}

function createRandomContact() {
	return {
		name: `Contact ${randomInt()}`,
		phoneNumber: null
	}
}

function subscribe({ headers, ...opts }, onMessage) {
	const ws = new WebSocket(GRAPH_QL_WS_URL, 'graphql-transport-ws')
	ws.binaryType = 'arraybuffer'

	ws.onmessage = (msg) => {
		const message = JSON.parse(msg.data)
		if(message.type === 'connection_ack') {
			ws.send(
				JSON.stringify({
					id: Date.now().toString(36),
					type: 'subscribe',
					payload: opts
				})
			)
			console.log('Connection Established with WebSocket')
			ws['connected'] = true
			return
		}

		if(message.type === 'data' || message.type === 'next') {
			onMessage(message)
			return
		}

		console.log('Unknown msg type: ', message)
	}

	ws.onopen = () => {
		ws.send(
			JSON.stringify({
				type: 'connection_init',
				payload: headers,
			})
		)
	}

	ws.onerror = (err) => {
		console.error('WebSocket error:', err)
	}

	return ws
}

async function conditionalTimeout(
	checkFn,
	timeoutMs = 5000,
	pollIntervalMs = 100
) {
	const start = Date.now()
	while(!checkFn()) {
		if(Date.now() - start > timeoutMs) {
			return false
		}

		await sleep(pollIntervalMs)
	}

	return true
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function randomInt() {
	return Math.floor(Math.random() * 100000000) % Date.now()
}
