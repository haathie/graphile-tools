import { check } from 'k6'
import http from 'k6/http'

const GRAPH_QL_URL = 'http://localhost:5678/graphql'

const UPSERT_TAGS_GQL = `
mutation TagsCreate($items: [TagsCreateItem!]!) {
  createTags(
    items: $items, onConflict: DoNothing
  ) {
    items {
			rowId
			name
    }
  }
}`

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

const SEARCH_CONTACTS_GQL = `
query GetContacts($search: String!) {
  contacts(
    orderBy: PRIMARY_KEY_DESC
    condition: {search: {icontains: $search}},
		first: 5
  ) {
    pageInfo {
      endCursor
      hasNextPage
    }
    nodes {
      ...ContactFragment
    }
  }
}

fragment ContactFragment on Contact {
  rowId
  name
  createdAt
  createdBy
  orgId
  assignee
  assignedBy
  assignedAt
  fullImg {
    url
  }
  contactTags {
    nodes {
      tag {
        name
        rowId
      }
      createdAt
      createdBy
    }
  }
  platformNames
}`

const TAGS_PER_TENANT = 10
const TAGS_PER_CONTACT = 5
const CONTACTS_PER_TENANT = 100

export const options = {
	vus: 100,
	duration: '60s',
}

export default function() {
	const defaultOpts = {
		headers: {
			'content-type': 'application/json',
			'org-id': `tenant-${__VU}`,
			'user-id': 'load-test-user',
		}
	}
	const tagsRes = http.post(
		GRAPH_QL_URL,
		JSON.stringify({
			query: UPSERT_TAGS_GQL,
			variables: {
				items: Array.from({ length: TAGS_PER_TENANT }, (_, i) => ({
					name: `Tag ${i}`,
				})),
			}
		}),
		{ ...defaultOpts, tags: { requestId: 'createTags' } }
	)
	check(tagsRes, { 'tags 200': (res) => res.status === 200 })
	const { data: { createTags: { items: createdTags } } } = tagsRes.json()

	const contacts = Array
		.from({ length: CONTACTS_PER_TENANT }, createRandomContact)
	const contactsRes = http.post(
		GRAPH_QL_URL,
		JSON.stringify({
			query: UPSERT_CONTACTS_GQL,
			variables: {
				items: contacts,
			}
		}),
		{ ...defaultOpts, tags: { requestId: 'createContacts' } }
	)
	check(contactsRes, { 'contacts 200': (res) => res.status === 200 })

	const firstContact = contacts[0]
	const searchRes = http.post(
		GRAPH_QL_URL,
		JSON.stringify({
			query: SEARCH_CONTACTS_GQL,
			variables: {
				search: firstContact.name.slice(8),
			}
		}),
		{ ...defaultOpts, tags: { requestId: 'searchContacts' } }
	)
	check(searchRes, { 'search 200': (res) => res.status === 200 })

	function createRandomContact() {
		const tagsToMake = (randomInt() % TAGS_PER_CONTACT)
		const tagIdsToMake = Array.from({ length: tagsToMake }, () => (
			createdTags[randomInt() % createdTags.length].rowId
		))
		return {
			name: `Contact ${randomInt()}`,
			phoneNumber: randomInt() % 2 === 0
				? randomInt()
				: null,
			contactTags: Array.from(new Set(tagIdsToMake)).map(tagId => ({ tagId }))
		}
	}
}

function randomInt() {
	return Math.floor(Math.random() * 100000000) % Date.now()
}
