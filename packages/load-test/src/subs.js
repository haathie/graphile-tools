import { check } from 'k6'
import { WebSocket } from 'k6/experimental/websockets'
import http from 'k6/http'
import { setTimeout } from 'k6/timers'

const GRAPH_QL_URL = 'http://localhost:5678/graphql'
const GRAPH_QL_WS_URL = 'ws://localhost:5678/graphql'

const UPSERT_CONTACTS_GQL = `
mutation ContactsCreate($items: [ContactsCreateItem!]!) {
  createContacts(
    items: $items, onConflict: Replace
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

const TAGS_PER_TENANT = 3
const TAGS_PER_CONTACT = 2

export const options = {
	'scenarios': {
		'constant_load': {
			'executor': 'constant-vus',
			'vus': 2000,
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

	const TAG_NAMES = Array
		.from({ length: TAGS_PER_TENANT }, (_, i) => `Tag ${i}`)

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
			const itemsRecv = msg.payload.data.contactsCreated.items
			// console.log(`Received items: ${itemsRecv.length}`, itemsRecv.map(i => i.orgId))
			msgReceived += itemsRecv.length
			check(
				itemsRecv,
				{
					'sub has data': m => !!m.length
				}
			)
		}
	)

	while(!ws.connected) {
		await sleep(100)
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

	const start = Date.now()
	while(
		msgReceived < contactsCreated
		// timeout after 5 seconds
		&& Date.now() - start < 5_000
	) {
		await sleep(100)
	}

	ws.close()
	check(msgReceived, { 'data received on sub': v => v === contactsCreated })

	console.log('VU done, success: ', msgReceived === contactsCreated)

	function createRandomContact() {
		const tagsToMake = randomInt() % TAGS_PER_CONTACT
		const tagNamesToMake = Array.from({ length: tagsToMake }, () => (
			TAG_NAMES[randomInt() % TAG_NAMES.length]
		))
		return {
			name: `Contact ${randomInt()}`,
			phoneNumber: null,
			contactTags: Array.from(new Set(tagNamesToMake))
				.map(name => ({ tag: { name } }))
		}
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

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function randomInt() {
	return Math.floor(Math.random() * 100000000) % Date.now()
}
