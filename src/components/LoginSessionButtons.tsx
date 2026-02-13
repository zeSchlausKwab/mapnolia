import {
	NDKNip07Signer,
	NDKSessionLocalStorage,
	type NDKNip46Signer,
	type NDKPrivateKeySigner,
	type NDKUser,
	removeStoredSession,
	useNDKCurrentUser,
	useNDKSessionLogin,
	useNDKSessionLogout,
	useProfileValue,
	type Hexpubkey,
} from '@nostr-dev-kit/react'
import { AppWindowIcon, KeyRoundIcon, LogOutIcon, QrCodeIcon, User2Icon } from 'lucide-react'
import { useState, useRef } from 'react'
import { Nip46LoginDialog } from './Nip46LoginDialog'
import { SignupDialog } from './SignupDialog'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * Display a mini profile with avatar and optional name
 */
function MiniProfile({ userOrPubkey }: { userOrPubkey?: Hexpubkey | NDKUser | null | undefined }) {
	const profile = useProfileValue(userOrPubkey)
	const pubkey =
		userOrPubkey instanceof Object && 'pubkey' in userOrPubkey ? userOrPubkey.pubkey : userOrPubkey

	// Get first 2 characters of name or pubkey for fallback
	const getFallbackText = () => {
		if (profile?.name) {
			return profile.name.substring(0, 2).toUpperCase()
		}
		if (profile?.displayName) {
			return profile.displayName.substring(0, 2).toUpperCase()
		}
		if (pubkey) {
			return pubkey.substring(0, 2).toUpperCase()
		}
		return '?'
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="outline" className="p-1 h-auto">
					<Avatar className="w-7 h-7">
						<AvatarImage
							src={profile?.image || profile?.picture}
							alt={profile?.name || 'Profile'}
						/>
						<AvatarFallback className="text-xs">
							{profile ? getFallbackText() : <User2Icon className="w-4 h-4" />}
						</AvatarFallback>
					</Avatar>
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p>
					{profile?.name ||
						profile?.displayName ||
						(pubkey ? `${pubkey.substring(0, 8)}...` : 'Profile')}
				</p>
			</TooltipContent>
		</Tooltip>
	)
}

export function LoginSessionButtons() {
	const login = useNDKSessionLogin()
	const logout = useNDKSessionLogout()
	const currentUser = useNDKCurrentUser()

	const [loading, setLoading] = useState(false)
	const [showSignupDialog, setShowSignupDialog] = useState(false)
	const storageRef = useRef(new NDKSessionLocalStorage())

	const handleSignup = async (signer: NDKPrivateKeySigner, rememberMe: boolean) => {
		try {
			await login(signer)
			// If user doesn't want to stay logged in, remove from persistent storage
			if (!rememberMe) {
				const user = await signer.user()
				if (user?.pubkey) {
					await removeStoredSession(storageRef.current, user.pubkey)
				}
			}
		} catch (error) {
			console.error('Login failed:', error)
			throw error
		}
	}

	const handleNip07Login = async () => {
		try {
			setLoading(true)
			const signer = new NDKNip07Signer()
			await login(signer)
			// NIP-07 always stays logged in (extension manages the key)
		} catch (error) {
			console.error('Extension login failed:', error)
		} finally {
			setLoading(false)
		}
	}

	const handleNip46Login = async (signer: NDKNip46Signer, rememberMe: boolean) => {
		try {
			setLoading(true)
			await login(signer)
			// If user doesn't want to stay logged in, remove from persistent storage
			if (!rememberMe) {
				const user = await signer.user()
				if (user?.pubkey) {
					await removeStoredSession(storageRef.current, user.pubkey)
				}
			}
		} catch (error) {
			console.error('NIP-46 login failed:', error)
			throw error
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex items-center gap-2">
			{currentUser ? (
				<ButtonGroup>
					<MiniProfile userOrPubkey={currentUser} />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant="outline" size="icon" onClick={() => logout()}>
								<LogOutIcon className="w-4 h-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Log out</p>
						</TooltipContent>
					</Tooltip>
				</ButtonGroup>
			) : (
				<ButtonGroup>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant={'secondary'} onClick={() => setShowSignupDialog(true)}>
								<KeyRoundIcon className="w-5 h-5" />
								signup
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Create a new nsec.</p>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant={'secondary'} onClick={handleNip07Login} disabled={loading}>
								<AppWindowIcon className="w-5 h-5" />
								{loading ? 'Logging in...' : 'extension'}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Use your nostr extension.</p>
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<Nip46LoginDialog
							onLogin={handleNip46Login}
							trigger={
								<TooltipTrigger asChild>
									<Button variant={'secondary'} disabled={loading}>
										<QrCodeIcon className="w-5 h-5" />
										{loading ? 'Logging in...' : 'signer'}
									</Button>
								</TooltipTrigger>
							}
						/>
						<TooltipContent>
							<p>Use an external signer.</p>
						</TooltipContent>
					</Tooltip>
				</ButtonGroup>
			)}

			{/* Signup Dialog */}
			<SignupDialog
				open={showSignupDialog}
				onOpenChange={setShowSignupDialog}
				onConfirm={handleSignup}
			/>
		</div>
	)
}
