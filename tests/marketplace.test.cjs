const {test, before, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const memdown = require('memdown');
const {ethers} = require('ethers');
const {compile} = require('../scripts/compile.cjs');
let compiled, rpc, provider, admin, seller, buyer, outsider, recipient, market;
const hash = ethers.ZeroHash;
const price = 1000n;
before(() => { compiled = compile().contracts; });
async function deploy(file,name,args=[],signer=admin) {
  const a=compiled[file][name];
  const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signer).deploy(...args);
  await c.waitForDeployment(); return c;
}
async function sent(promise) { return (await promise).wait(); }
async function balance(address) {
  return BigInt(await rpc.request({method:'eth_getBalance',params:[address,'latest']}));
}
async function list(qty=5n,p=price) {
  await sent(market.connect(seller).listItem('Notebook','Study listing',p,qty,hash));
  return (await market.nextItemId())-1n;
}
beforeEach(async () => {
  rpc=ganache.provider({logging:{quiet:true},wallet:{totalAccounts:6},chain:{hardfork:'shanghai'},database:{db:memdown()}});
  provider=new ethers.BrowserProvider(rpc);
  provider.pollingInterval=10;
  [admin,seller,buyer,outsider,recipient]=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
  market=await deploy('Marketplace.sol','Marketplace',['Study Market']);
});
afterEach(async () => { if(provider) await provider.destroy(); if(rpc) await rpc.disconnect(); });

test('lists item, records seller index and emits event',async()=>{
  const receipt=await sent(market.connect(seller).listItem('Notebook','Study listing',price,5,hash));
  const item=await market.getItem(1);
  assert.equal(item.seller,await seller.getAddress());
  assert.equal(item.name,'Notebook'); assert.equal(item.price,price);
  assert.equal(item.quantity,5n); assert.equal(item.active,true);
  assert.deepEqual(Array.from(await market.getSellerItemIds(await seller.getAddress())),[1n]);
  assert.equal(market.interface.parseLog(receipt.logs[0]).name,'ItemListed');
});
test('validates missing items and listing inputs',async()=>{
  await assert.rejects(market.getItem(99),/ItemNotFound/);
  await assert.rejects(market.connect(seller).listItem.staticCall('','x',price,1,hash),/InvalidText/);
  await assert.rejects(market.connect(seller).listItem.staticCall('x','x',0,1,hash),/ZeroPrice/);
  await assert.rejects(market.connect(seller).listItem.staticCall('x','x',price,0,hash),/ZeroQuantity/);
});
test('only seller can edit or delete; edit updates item',async()=>{
  await list();
  await assert.rejects(market.connect(outsider).updateItem.staticCall(1,'Changed','x',2,3,hash),/NotSeller/);
  await assert.rejects(market.connect(outsider).deleteItem.staticCall(1),/NotSeller/);
  await sent(market.connect(seller).updateItem(1,'Changed','New',2000,8,hash));
  const item=await market.getItem(1);
  assert.equal(item.name,'Changed'); assert.equal(item.quantity,8n); assert.equal(item.price,2000n);
});
test('purchase changes inventory, credits and history without paying seller immediately',async()=>{
  await list(); const sellerBefore=await balance(await seller.getAddress());
  const receipt=await sent(market.connect(buyer).buy(1,2,{value:price*2n}));
  assert.equal((await market.getItem(1)).quantity,3n);
  assert.equal(await market.pendingWithdrawals(await seller.getAddress()),2000n);
  assert.equal(await balance(await seller.getAddress()),sellerBefore);
  assert.equal(await market.totalEscrow(),2000n); assert.equal(await market.unitsSold(1),2n);
  const order=await market.getPurchase(0);
  assert.equal(order.buyer,await buyer.getAddress()); assert.equal(order.unitPrice,price);
  assert.equal(order.quantity,2n); assert.equal(order.totalPaid,2000n);
  assert.equal(market.interface.parseLog(receipt.logs[0]).name,'ItemPurchased');
});
test('rejects invalid quantity, insufficient stock, self-purchase and wrong payment',async()=>{
  await list();
  await assert.rejects(market.connect(buyer).buy.staticCall(1,0),/ZeroQuantity/);
  await assert.rejects(market.connect(buyer).buy.staticCall(1,6,{value:6000}),/OutOfStock/);
  await assert.rejects(market.connect(seller).buy.staticCall(1,1,{value:price}),/SelfPurchase/);
  await assert.rejects(market.connect(buyer).buy.staticCall(1,1,{value:999}),/WrongPayment/);
  await assert.rejects(market.connect(buyer).buy.staticCall(1,1,{value:1001}),/WrongPayment/);
  assert.equal(await market.totalEscrow(),0n); assert.equal((await market.getItem(1)).quantity,5n);
});
test('soft deletion blocks new sales while keeping old order history',async()=>{
  await list(); await sent(market.connect(buyer).buy(1,1,{value:price}));
  await sent(market.connect(seller).deleteItem(1));
  assert.equal((await market.getItem(1)).active,false);
  await assert.rejects(market.connect(buyer).buy.staticCall(1,1,{value:price}),/InactiveItem/);
  assert.equal((await market.getPurchase(0)).totalPaid,price);
  assert.equal(await market.pendingWithdrawals(await seller.getAddress()),price);
});
test('seller withdraws only their credit to a chosen recipient',async()=>{
  await list(); await sent(market.connect(buyer).buy(1,2,{value:2000}));
  const to=await recipient.getAddress(); const beforeBalance=await balance(to);
  await sent(market.connect(seller).withdraw(to));
  assert.equal(await balance(to)-beforeBalance,2000n);
  assert.equal(await market.pendingWithdrawals(await seller.getAddress()),0n);
  assert.equal(await market.totalEscrow(),0n);
  await assert.rejects(market.connect(outsider).withdraw.staticCall(to),/NoProceeds/);
  await assert.rejects(market.connect(seller).withdraw.staticCall(ethers.ZeroAddress),/InvalidRecipient/);
});
test('failed recipient transfer restores credit and escrow',async()=>{
  await list(); await sent(market.connect(buyer).buy(1,1,{value:price}));
  const reject=await deploy('TestActors.sol','RejectEther');
  await assert.rejects(async()=>{
    const tx=await market.connect(seller).withdraw(await reject.getAddress(),{gasLimit:500000});
    await tx.wait();
  });
  assert.equal(await market.pendingWithdrawals(await seller.getAddress()),price);
  assert.equal(await market.totalEscrow(),price);
  assert.equal(await balance(await market.getAddress()),price);
});
test('malicious seller cannot reenter withdrawal or take another seller credit',async()=>{
  await list(); await sent(market.connect(buyer).buy(1,1,{value:price}));
  const attacker=await deploy('TestActors.sol','ReenteringSeller',[await market.getAddress()]);
  await sent(attacker.list(700));
  await sent(market.connect(buyer).buy(2,1,{value:700}));
  await sent(attacker.claim());
  assert.equal(await attacker.reentryBlocked(),true);
  assert.equal(await balance(await attacker.getAddress()),700n);
  assert.equal(await market.pendingWithdrawals(await attacker.getAddress()),0n);
  assert.equal(await market.pendingWithdrawals(await seller.getAddress()),price);
  assert.equal(await market.totalEscrow(),price);
  assert.equal(await balance(await market.getAddress()),price);
});
test('sold-out listing can be restocked by seller',async()=>{
  await list(1); await sent(market.connect(buyer).buy(1,1,{value:price}));
  await assert.rejects(market.connect(buyer).buy.staticCall(1,1,{value:price}),/OutOfStock/);
  await sent(market.connect(seller).updateItem(1,'Restocked','x',price,3,hash));
  assert.equal((await market.getItem(1)).quantity,3n);
});
test('later edits do not change recorded historical unit prices',async()=>{
  await list(); await sent(market.connect(buyer).buy(1,1,{value:price}));
  await sent(market.connect(seller).updateItem(1,'New price','x',3000,4,hash));
  await sent(market.connect(outsider).buy(1,1,{value:3000}));
  assert.equal(await market.purchaseCount(),2n);
  assert.equal((await market.getPurchase(0)).unitPrice,1000n);
  assert.equal((await market.getPurchase(1)).unitPrice,3000n);
  assert.equal(await market.totalEscrow(),4000n);
});
test('checked arithmetic prevents wrapped purchase totals',async()=>{
  await list(2n,ethers.MaxUint256);
  await assert.rejects(market.connect(buyer).buy.staticCall(1,2,{value:0}));
  assert.equal((await market.getItem(1)).quantity,2n);
  assert.equal(await market.totalEscrow(),0n);
});
