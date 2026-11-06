// Trello setup helper. Reads the key and token from .env.local and never prints them.
//   npm run setup:trello -- lists   boards and list ids, to choose TRELLO_LIST_ID
//   npm run setup:trello -- check   confirms TRELLO_LIST_ID is reachable

const { TRELLO_API_KEY: key, TRELLO_TOKEN: token, TRELLO_LIST_ID: listId } = process.env;
if (!key || !token) {
  console.error("TRELLO_API_KEY and TRELLO_TOKEN are missing in .env.local");
  process.exit(1);
}

async function api(path: string) {
  const response = await fetch(`https://api.trello.com/1${path}`, {
    headers: { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` },
  });
  if (!response.ok) throw new Error(`${path.split("?")[0]}: ${response.status} ${await response.text()}`);
  return response.json();
}

const [command] = process.argv.slice(2);

if (command === "lists") {
  const boards = (await api("/members/me/boards?fields=name&filter=open&lists=open&list_fields=name")) as { name: string; lists: { id: string; name: string }[] }[];
  for (const board of boards) {
    console.log(`\n${board.name}`);
    for (const list of board.lists) console.log(`  ${list.id}  ${list.name}`);
  }
} else if (command === "check") {
  if (!listId) throw new Error("TRELLO_LIST_ID is missing in .env.local");
  const list = (await api(`/lists/${listId}?fields=name`)) as { name: string };
  console.log(`OK: cards will go to the list "${list.name}"`);
} else {
  console.log("Commands: lists, check");
}

export {};
