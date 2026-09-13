import { world, system, EquipmentSlot, EntityComponentTypes, BlockComponentTypes } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const POUCH_ID = "nivek:potion_pouch";
const MAX_POTIONS = 16;
const POTION_ITEM_IDS = ["minecraft:potion", "minecraft:splash_potion", "minecraft:lingering_potion"];

const POUCH_ID_KEY = "nivek:pouchId";
const OWNER_KEY = "nivek:vaultOwner";
const VAULT_INIT_KEY = "nivek:vaultInitialized";
const VAULT_CHEST_COUNT_KEY = "nivek:vaultChestCount";
const TICKING_AREA_NAME = "nivek_potionpouch_vault";

const VAULT_DIMENSION = "overworld";
// Deep underground, arbitrary/unused coordinates. The whole rectangle below
// is kept permanently simulated by a ticking area so it works with no
// players anywhere nearby.
const VAULT_ORIGIN = { x: 0, y: -60, z: 0 };
const VAULT_CHEST_SPACING = 2; // blocks between chest centers along X
const VAULT_AREA_CHESTS = 40; // how many chest slots the ticking area rectangle can fit

function vaultDimension() {
  return world.getDimension(VAULT_DIMENSION);
}

function chestLocation(index) {
  return { x: VAULT_ORIGIN.x + index * VAULT_CHEST_SPACING, y: VAULT_ORIGIN.y, z: VAULT_ORIGIN.z };
}

function sealBlock(dim, loc) {
  const b = dim.getBlock(loc);
  if (b && b.typeId !== "minecraft:bedrock") {
    b.setType("minecraft:bedrock");
  }
}

function entombChest(dim, loc) {
  const offsets = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ];
  for (const o of offsets) {
    sealBlock(dim, { x: loc.x + o.x, y: loc.y + o.y, z: loc.z + o.z });
  }
}

function createChestAt(index) {
  const dim = vaultDimension();
  const loc = chestLocation(index);
  const block = dim.getBlock(loc);
  if (!block) return null;
  if (block.typeId !== "minecraft:chest") {
    block.setType("minecraft:chest");
  }
  entombChest(dim, loc);
  return block;
}

function getChestContainer(index) {
  const dim = vaultDimension();
  const loc = chestLocation(index);
  const block = dim.getBlock(loc);
  if (!block) return null;
  if (block.typeId !== "minecraft:chest") {
    // Shouldn't happen once created, but recreate defensively.
    createChestAt(index);
  }
  const inv = dim.getBlock(loc)?.getComponent(BlockComponentTypes.Inventory);
  return inv ? inv.container : null;
}

function getChestCount() {
  return world.getDynamicProperty(VAULT_CHEST_COUNT_KEY) ?? 0;
}

function setChestCount(n) {
  world.setDynamicProperty(VAULT_CHEST_COUNT_KEY, n);
}

function initVault() {
  if (world.getDynamicProperty(VAULT_INIT_KEY)) return;

  const dim = vaultDimension();
  const from = { x: VAULT_ORIGIN.x - 2, y: VAULT_ORIGIN.y - 2, z: VAULT_ORIGIN.z - 4 };
  const to = {
    x: VAULT_ORIGIN.x + VAULT_AREA_CHESTS * VAULT_CHEST_SPACING + 2,
    y: VAULT_ORIGIN.y + 2,
    z: VAULT_ORIGIN.z + 4,
  };
  dim.runCommand(
    `tickingarea add ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${TICKING_AREA_NAME}`
  );

  // Give the newly-added ticking area a moment to actually load/simulate
  // the chunks before we try to place blocks in them.
  system.runTimeout(() => {
    createChestAt(0);
    setChestCount(1);
    world.setDynamicProperty(VAULT_INIT_KEY, true);
  }, 20);
}

function allChestIndices() {
  const count = getChestCount();
  const indices = [];
  for (let i = 0; i < count; i++) indices.push(i);
  return indices;
}

function findFreeVaultSlot() {
  for (const i of allChestIndices()) {
    const container = getChestContainer(i);
    if (!container) continue;
    for (let slot = 0; slot < container.size; slot++) {
      if (!container.getItem(slot)) {
        return { container, slot };
      }
    }
  }
  // No free slot in existing chests: grow the vault.
  const newIndex = getChestCount();
  const block = createChestAt(newIndex);
  if (!block) return null;
  setChestCount(newIndex + 1);
  const container = getChestContainer(newIndex);
  if (!container) return null;
  return { container, slot: 0 };
}

function collectPouchEntries(pouchId) {
  const entries = [];
  for (const i of allChestIndices()) {
    const container = getChestContainer(i);
    if (!container) continue;
    for (let slot = 0; slot < container.size; slot++) {
      const stack = container.getItem(slot);
      if (!stack) continue;
      if (stack.getDynamicProperty(OWNER_KEY) === pouchId) {
        entries.push({ container, slot, stack });
      }
    }
  }
  return entries;
}

function typeLabel(typeId) {
  if (typeId === "minecraft:potion") return "Potion";
  if (typeId === "minecraft:splash_potion") return "Splash Potion";
  if (typeId === "minecraft:lingering_potion") return "Lingering Potion";
  return typeId;
}

function writeBackPouch(player, pouchStack) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (equippable) {
    equippable.setEquipment(EquipmentSlot.Mainhand, pouchStack);
  }
}

function getOrAssignPouchId(player, pouchStack) {
  let id = pouchStack.getDynamicProperty(POUCH_ID_KEY);
  if (typeof id === "string" && id.length > 0) return { id, stack: pouchStack };

  id = `p_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const updated = pouchStack.clone();
  updated.setDynamicProperty(POUCH_ID_KEY, id);
  writeBackPouch(player, updated);
  return { id, stack: updated };
}

function findPotionSlotsInInventory(player) {
  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const results = [];
  for (let i = 0; i < container.size; i++) {
    const stack = container.getItem(i);
    if (!stack) continue;
    if (!POTION_ITEM_IDS.includes(stack.typeId)) continue;
    results.push({ slot: i, stack });
  }
  return results;
}

async function openMainMenu(player, pouchId) {
  const count = collectPouchEntries(pouchId).length;
  const form = new ActionFormData()
    .title("Potion Pouch")
    .body(`Holding ${count}/${MAX_POTIONS} potions.`)
    .button("Store a Potion")
    .button("Take a Potion");

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  if (response.selection === 0) {
    await openStoreMenu(player, pouchId);
  } else {
    await openTakeMenu(player, pouchId);
  }
}

async function openStoreMenu(player, pouchId) {
  const currentCount = collectPouchEntries(pouchId).length;
  if (currentCount >= MAX_POTIONS) {
    player.sendMessage("§cYour Potion Pouch is full.");
    return;
  }

  const candidates = findPotionSlotsInInventory(player);
  if (candidates.length === 0) {
    player.sendMessage("§cYou don't have any potions to store.");
    return;
  }

  const form = new ActionFormData().title("Store a Potion");
  for (const c of candidates) {
    form.button(`${typeLabel(c.stack.typeId)} x${c.stack.amount}`);
  }

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  const chosen = candidates[response.selection];

  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const currentSlotStack = container.getItem(chosen.slot);
  if (!currentSlotStack || currentSlotStack.typeId !== chosen.stack.typeId) {
    player.sendMessage("§cThat potion is no longer there.");
    return;
  }

  const freshCount = collectPouchEntries(pouchId).length;
  if (freshCount >= MAX_POTIONS) {
    player.sendMessage("§cYour Potion Pouch is full.");
    return;
  }

  const vaultSlot = findFreeVaultSlot();
  if (!vaultSlot) {
    player.sendMessage("§cCouldn't find space in the vault. Try again.");
    return;
  }

  const toStore = currentSlotStack.clone();
  toStore.amount = 1;
  toStore.setDynamicProperty(OWNER_KEY, pouchId);
  vaultSlot.container.setItem(vaultSlot.slot, toStore);

  if (currentSlotStack.amount <= 1) {
    container.setItem(chosen.slot, undefined);
  } else {
    const reduced = currentSlotStack.clone();
    reduced.amount = currentSlotStack.amount - 1;
    container.setItem(chosen.slot, reduced);
  }

  player.sendMessage(`§aStored ${typeLabel(currentSlotStack.typeId)}.`);
}

async function openTakeMenu(player, pouchId) {
  const entries = collectPouchEntries(pouchId);
  if (entries.length === 0) {
    player.sendMessage("§cYour Potion Pouch is empty.");
    return;
  }

  const form = new ActionFormData().title("Take a Potion");
  entries.forEach((e, i) => form.button(`${typeLabel(e.stack.typeId)} #${i + 1}`));

  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;

  const freshEntries = collectPouchEntries(pouchId);
  const entry = freshEntries[response.selection];
  if (!entry) {
    player.sendMessage("§cThat potion is no longer there.");
    return;
  }

  const toGive = entry.stack.clone();
  toGive.setDynamicProperty(OWNER_KEY, undefined);

  const inventory = player.getComponent(EntityComponentTypes.Inventory);
  const container = inventory.container;
  const leftover = container.addItem(toGive);
  if (leftover) {
    player.dimension.spawnItem(leftover, player.location);
  }

  entry.container.setItem(entry.slot, undefined);
  player.sendMessage(`§aTook ${typeLabel(entry.stack.typeId)}.`);
}

world.afterEvents.itemUse.subscribe((event) => {
  const { source: player, itemStack } = event;
  if (!itemStack || itemStack.typeId !== POUCH_ID) return;
  if (player.typeId !== "minecraft:player") return;

  initVault();

  system.run(() => {
    const { id: pouchId } = getOrAssignPouchId(player, itemStack);
    openMainMenu(player, pouchId).catch((e) => console.warn("Potion Pouch UI error: " + e));
  });
});
