/**
 * The island's icons: thin line drawings (Lucide, through react-icons), the
 * same weight as the icons in the start app's panels. Use these instead of
 * pictographs typed into text (a sword, a skull, a crown, arrows), which fall
 * back to whatever font the device has and never match.
 *
 * Every icon takes `size` (px, default 16) and inherits its colour from the
 * text around it. They are decorative by default (aria-hidden); give the
 * button that holds one an aria-label.
 */

import {
  LuActivity, LuArrowDownToLine, LuArrowLeft, LuArrowRight, LuBot, LuCast, LuCheck,
  LuChevronDown, LuChevronLeft, LuChevronRight, LuChevronUp, LuCircleHelp, LuClapperboard,
  LuCoins, LuCopy, LuCrosshair, LuCrown, LuDoorOpen, LuExternalLink, LuEye, LuFlag, LuHeart,
  LuHexagon, LuInfo, LuKeyRound, LuLink, LuLock, LuLockOpen, LuMap, LuMinus,
  LuPanelLeftClose, LuPanelRightClose, LuPause, LuPlay, LuPlus, LuQrCode, LuRadio,
  LuRotateCw, LuScrollText, LuSettings, LuShield, LuSkull, LuSword, LuSwords, LuTarget,
  LuTrash2, LuTriangleAlert, LuTrophy, LuUser, LuVideo, LuVolume2, LuVolumeX, LuWallet, LuX,
  LuZap,
} from 'react-icons/lu';

const wrap = (Glyph) => function Icon({ size = 16, className = '', ...rest }) {
  return <Glyph size={size} strokeWidth={1.7} aria-hidden className={`qf-icon ${className}`} {...rest} />;
};

// the game
export const IconKills = wrap(LuSwords);
export const IconWeapon = wrap(LuSword);
export const IconDead = wrap(LuSkull);
export const IconCrown = wrap(LuCrown);
export const IconTrophy = wrap(LuTrophy);
export const IconHealth = wrap(LuHeart);
export const IconTarget = wrap(LuTarget);
export const IconCrosshair = wrap(LuCrosshair);
export const IconDescend = wrap(LuArrowDownToLine);
export const IconDoor = wrap(LuDoorOpen);
export const IconMap = wrap(LuMap);
export const IconHex = wrap(LuHexagon);
export const IconFlag = wrap(LuFlag);
export const IconAgent = wrap(LuBot);
export const IconThought = wrap(LuActivity);
export const IconDanger = wrap(LuZap);
export const IconShield = wrap(LuShield);

// money and the chain
export const IconPool = wrap(LuCoins);
export const IconWallet = wrap(LuWallet);
export const IconYou = wrap(LuUser);
export const IconLock = wrap(LuLock);
export const IconUnlock = wrap(LuLockOpen);
export const IconExternal = wrap(LuExternalLink);
export const IconLink = wrap(LuLink);
export const IconLog = wrap(LuScrollText);

// the broadcast
export const IconFollow = wrap(LuEye);
export const IconDirector = wrap(LuClapperboard);
export const IconCamera = wrap(LuVideo);
export const IconCast = wrap(LuCast);
export const IconLive = wrap(LuRadio);
export const IconSoundOn = wrap(LuVolume2);
export const IconSoundOff = wrap(LuVolumeX);
export const IconPause = wrap(LuPause);
export const IconPlay = wrap(LuPlay);

// controls
export const IconSettings = wrap(LuSettings);
export const IconHelp = wrap(LuCircleHelp);
export const IconInfo = wrap(LuInfo);
export const IconWarn = wrap(LuTriangleAlert);
export const IconClose = wrap(LuX);
export const IconCheck = wrap(LuCheck);
export const IconCopy = wrap(LuCopy);
export const IconPlus = wrap(LuPlus);
export const IconMinus = wrap(LuMinus);
export const IconTrash = wrap(LuTrash2);
export const IconKey = wrap(LuKeyRound);
export const IconQr = wrap(LuQrCode);
export const IconRetry = wrap(LuRotateCw);
export const IconLeft = wrap(LuChevronLeft);
export const IconRight = wrap(LuChevronRight);
export const IconUp = wrap(LuChevronUp);
export const IconDown = wrap(LuChevronDown);
export const IconArrowLeft = wrap(LuArrowLeft);
export const IconArrowRight = wrap(LuArrowRight);
export const IconFoldLeft = wrap(LuPanelLeftClose);
export const IconFoldRight = wrap(LuPanelRightClose);
