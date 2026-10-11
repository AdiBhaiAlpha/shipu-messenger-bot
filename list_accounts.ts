import { messengerAccountsData } from './src/db/database';
import { connectDatabase } from './src/db/firebaseDb';

async function list() {
    await connectDatabase();
    const accounts = await messengerAccountsData.getAll();
    console.log(JSON.stringify(accounts, null, 2));
    process.exit(0);
}
list();
