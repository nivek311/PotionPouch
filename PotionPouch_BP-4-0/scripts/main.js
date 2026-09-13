import { world, system, EquipmentSlot, EntityComponentTypes, ItemComponentTypes, Potions } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const POUCH_ID = "nivek:potion_pouch";
const MAX_POTIONS = 16;
const CONTENTS_KEY = "nivek:contents";
const POTION_ITEM_IDS = ["minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion"];

function getContents(pouchStack) {
  const raw = pouchStack.getDynamicProperty(CONTENTS_KEY);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setContents(pouchStack, contents) {
  pouchStack.setDynamicProperty(CONTENTS_KEY, JSON.stringify(contents));
}

function describeEffect(effectId) {
  const raw = effectId.includes(":") ? effectId.split(":")[1] : effectId;
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeDelivery(deliveryId) {
  if (deliveryId === "Consume") return "Potion";
  if (deliveryId === "ThrownSplash") return "Splash Potion";
  if (deliveryId === "ThrownLingering") return "Lingering Potion";
  return deliveryId;
}

function writeBackPouch(player, pouchStack) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (equippable) {
    equippable.setEquipment(EquipmentSlot.Mainhand, pouchStack);
  }
}

function findPotionSlots(player) {
  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const results = [];
  for (let i = 0; i < container.size; i++) {
    const stack = container.getItem(i);
    if (!stack) continue;
    if (!POTION_ITEM_IDS.includes(stack.typeId)) continue;
    const potionComp = stack.getComponent(ItemComponentTypes.Potion);
    if (!potionComp) continue;
    results.push({ slot: i, stack, potionComp });
  }
  return results;
}

async function openMainMenu(player, pouchStack) {
  const contents = getContents(pouchStack);
  const form = new ActionFormData()
    .title("Potion Pouch")
    .body(`Holding ${contents.length}/${MAX_POTIONS} potions.`)
    .button("Store a Potion")
    .button("Take a Potion");

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  if (response.selection === 0) {
    await openStoreMenu(player, pouchStack);
  } else {
    await openTakeMenu(player, pouchStack);
  }
}

async function openStoreMenu(player, pouchStack) {
  const contents = getContents(pouchStack);
  if (contents.length >= MAX_POTIONS) {
    player.sendMessage("§cYour Potion Pouch is full.");
    return;
  }

  const candidates = findPotionSlots(player);
  if (candidates.length === 0) {
    player.sendMessage("§cYou don't have any potions to store.");
    return;
  }

  const form = new ActionFormData().title("Store a Potion");
  for (const c of candidates) {
    const label = `${describeDelivery(c.potionComp.potionDeliveryType.id)} of ${describeEffect(
      c.potionComp.potionEffectType.id
    )} x${c.stack.amount}`;
    form.button(label);
  }

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  const chosen = candidates[response.selection];

  // Re-check the slot in case the player's inventory changed while the form was open.
  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const currentSlotStack = container.getItem(chosen.slot);
  if (!currentSlotStack || currentSlotStack.typeId !== chosen.stack.typeId) {
    player.sendMessage("§cThat potion is no longer there.");
    return;
  }

  const potionComp = currentSlotStack.getComponent(ItemComponentTypes.Potion);
  if (!potionComp) return;

  if (currentSlotStack.amount <= 1) {
    container.setItem(chosen.slot, undefined);
  } else {
    const reduced = currentSlotStack.clone();
    reduced.amount = currentSlotStack.amount - 1;
    container.setItem(chosen.slot, reduced);
  }

  const freshContents = getContents(pouchStack);
  if (freshContents.length >= MAX_POTIONS) {
    // Pouch filled up by another action while the form was open; give the potion back.
    container.addItem(currentSlotStack.clone());
    player.sendMessage("§cYour Potion Pouch is full.");
    return;
  }

  freshContents.push({ effect: potionComp.potionEffectType.id, delivery: potionComp.potionDeliveryType.id });
  setContents(pouchStack, freshContents);
  writeBackPouch(player, pouchStack);
  player.sendMessage(
    `§aStored ${describeDelivery(potionComp.potionDeliveryType.id)} of ${describeEffect(potionComp.potionEffectType.id)}.`
  );
}

async function openTakeMenu(player, pouchStack) {
  const contents = getContents(pouchStack);
  if (contents.length === 0) {
    player.sendMessage("§cYour Potion Pouch is empty.");
    return;
  }

  const form = new ActionFormData().title("Take a Potion");
  for (const entry of contents) {
    form.button(`${describeDelivery(entry.delivery)} of ${describeEffect(entry.effect)}`);
  }

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  const freshContents = getContents(pouchStack);
  const index = response.selection;
  const entry = freshContents[index];
  if (!entry) return;

  const effectType = Potions.getEffectType(entry.effect);
  const deliveryType = Potions.getDeliveryType(entry.delivery);
  if (!effectType || !deliveryType) {
    player.sendMessage("§cCouldn't restore that potion.");
    return;
  }

  const newStack = Potions.resolve(effectType, deliveryType);

  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const leftover = container.addItem(newStack);
  if (leftover) {
    player.dimension.spawnItem(leftover, player.location);
  }

  freshContents.splice(index, 1);
  setContents(pouchStack, freshContents);
  writeBackPouch(player, pouchStack);
  player.sendMessage(`§aTook ${describeDelivery(entry.delivery)} of ${describeEffect(entry.effect)}.`);
}

world.afterEvents.itemUse.subscribe((event) => {
  const { source: player, itemStack } = event;
  if (!itemStack || itemStack.typeId !== POUCH_ID) return;
  if (player.typeId !== "minecraft:player") return;

  system.run(() => {
    openMainMenu(player, itemStack).catch((e) => console.warn("Potion Pouch UI error: " + e));
  });
});
