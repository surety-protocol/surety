/*!
 * tUSDC – Mock NEP-141 Fungible Token for Surety testnet.
 *
 * Compatible with near-sdk 5.30.x / near-contract-standards 5.30.x.
 *
 * Features:
 *   - NEP-141 fungible token (ft_transfer, ft_transfer_call, ft_resolve_transfer)
 *   - NEP-145 storage management (storage_deposit, storage_withdraw, storage_unregister)
 *   - FungibleTokenMetadata (symbol="tUSDC", decimals=6, name="Test USDC")
 *   - Owner-only mint
 */

use near_contract_standards::fungible_token::{
    core::FungibleTokenCore,
    metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC},
    resolver::FungibleTokenResolver,
    FungibleToken,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::{
    collections::LazyOption,
    env,
    json_types::U128,
    log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};

// ── Storage keys ─────────────────────────────────────────────────────────────

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    FungibleToken,
    Metadata,
}

// ── Contract state ───────────────────────────────────────────────────────────

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TUsdcToken {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
}

// ── Init + mint ───────────────────────────────────────────────────────────────

#[near]
impl TUsdcToken {
    /// Initialize the token.  `owner_id` is the sole mint authority.
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        require!(!env::state_exists(), "Already initialized");
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        let mut this = Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner_id: owner_id.clone(),
        };
        // Register the owner so they can hold tokens without paying storage separately.
        this.token.internal_register_account(&owner_id);
        this
    }

    /// Mint `amount` token units into `account_id`.
    /// Only callable by the contract owner.
    /// Auto-registers `account_id` if not already registered.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can mint"
        );
        require!(amount.0 > 0, "Amount must be positive");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        log!("Minted {} tUSDC units to {}", amount.0, account_id);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mint"),
        }
        .emit();
    }

    /// Return the owner account id.
    pub fn owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}

// ── NEP-141 core ─────────────────────────────────────────────────────────────

#[near]
impl FungibleTokenCore for TUsdcToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

// ── NEP-141 resolver ─────────────────────────────────────────────────────────

#[near]
impl FungibleTokenResolver for TUsdcToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, _burned_amount) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }
}

// ── NEP-145 storage management ───────────────────────────────────────────────

#[near]
impl StorageManagement for TUsdcToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

// ── Metadata ─────────────────────────────────────────────────────────────────

#[near]
impl FungibleTokenMetadataProvider for TUsdcToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{
        test_utils::{accounts, VMContextBuilder},
        testing_env,
    };

    /// Helper: set up a fresh contract with accounts(1) as owner.
    fn setup() -> TUsdcToken {
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        TUsdcToken::new(accounts(1))
    }

    // ── mint ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_mint_by_owner_succeeds() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(1_000_000));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 1_000_000);
    }

    #[test]
    fn test_mint_to_new_account_auto_registers() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        // accounts(2) not pre-registered; mint should register it automatically
        contract.mint(accounts(2), U128(500_000));
        assert_eq!(contract.ft_balance_of(accounts(2)).0, 500_000);
    }

    #[test]
    fn test_mint_accumulates() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(1_000_000));
        contract.mint(accounts(1), U128(2_000_000));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 3_000_000);
    }

    #[test]
    #[should_panic(expected = "Only the owner can mint")]
    fn test_mint_by_non_owner_panics() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(2)) // not the owner
            .build());
        contract.mint(accounts(2), U128(1_000_000));
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn test_mint_zero_panics() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(0));
    }

    // ── transfer ─────────────────────────────────────────────────────────────

    #[test]
    fn test_transfer_succeeds() {
        let mut contract = setup();

        // Mint 5 tUSDC to owner
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(5_000_000));

        // Register recipient (accounts(2)) with a storage deposit
        let storage_cost = env::storage_byte_cost().saturating_mul(125);
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(2))
            .attached_deposit(storage_cost)
            .build());
        contract.storage_deposit(Some(accounts(2)), None);

        // Transfer 1 tUSDC from accounts(1) → accounts(2)
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.ft_transfer(accounts(2), U128(1_000_000), None);

        assert_eq!(contract.ft_balance_of(accounts(1)).0, 4_000_000);
        assert_eq!(contract.ft_balance_of(accounts(2)).0, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "The account doesn't have enough balance")]
    fn test_transfer_insufficient_balance_panics() {
        let mut contract = setup();

        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(100));

        // Register recipient
        let storage_cost = env::storage_byte_cost().saturating_mul(125);
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(2))
            .attached_deposit(storage_cost)
            .build());
        contract.storage_deposit(Some(accounts(2)), None);

        // Try to transfer more than balance
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        contract.ft_transfer(accounts(2), U128(1_000_000), None);
    }

    // ── metadata ─────────────────────────────────────────────────────────────

    #[test]
    fn test_metadata() {
        let contract = setup();
        let meta = contract.ft_metadata();
        assert_eq!(meta.symbol, "tUSDC");
        assert_eq!(meta.decimals, 6);
        assert_eq!(meta.name, "Test USDC");
    }

    // ── total supply ─────────────────────────────────────────────────────────

    #[test]
    fn test_total_supply_increases_on_mint() {
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        assert_eq!(contract.ft_total_supply().0, 0);
        contract.mint(accounts(1), U128(10_000_000));
        assert_eq!(contract.ft_total_supply().0, 10_000_000);
        contract.mint(accounts(1), U128(5_000_000));
        assert_eq!(contract.ft_total_supply().0, 15_000_000);
    }

    // ── storage management ───────────────────────────────────────────────────

    #[test]
    fn test_storage_deposit_and_balance() {
        let mut contract = setup();
        let storage_cost = env::storage_byte_cost().saturating_mul(125);
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(2))
            .attached_deposit(storage_cost)
            .build());
        let balance = contract.storage_deposit(Some(accounts(2)), None);
        assert!(balance.total > NearToken::from_yoctonear(0));
        assert!(contract.storage_balance_of(accounts(2)).is_some());
    }

    // ── ft_transfer_call arg-validation ─────────────────────────────────────

    #[test]
    fn test_ft_balance_before_transfer_call() {
        // Verifies the sender has balance before ft_transfer_call would be dispatched.
        // The actual cross-contract execution is covered by near-workspaces integration tests.
        let mut contract = setup();
        testing_env!(VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .build());
        contract.mint(accounts(1), U128(10_000_000));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 10_000_000);
    }
}
